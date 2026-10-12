// Analytix: AI Insider Alerts — "Keep the customer" runner. Reads one query
// per UTC day through the user's own ClickHouse datasource, keeps the days in
// the engine (so moving the as-of day by one reads one new day, and a run
// stopped by a failure continues from the days already read), evaluates the
// rules or the backtest, and optionally adds GA4 evidence from the backend
// for the accounts at risk. Nothing is sent anywhere.

import { DataSourceRef } from '@grafana/data';
import { fetchKeepBehavior } from 'app/features/dashboard-scene/ai-panel/assistantClient';

import { num, str } from '../coerce';
import { isTimeoutError, isTransientNotTimeout, queryFrame, queryRows } from '../query';

import { blockFromFrame } from './blocks';
import { graceDays, ruleDays } from './engine';
import { accountDaysSql, estimateSql } from './sql';
import {
  BacktestReport,
  BehaviorResult,
  BehaviorRow,
  BehaviorStatusCode,
  DayBlock,
  DayLevel,
  KEEP_DAY_SETTLE_SEC,
  KEEP_MAX_ACCOUNT_DAYS,
  KEEP_MAX_SCAN_DAYS,
  KEEP_PARALLEL_DAYS,
  KEEP_SQL_VERSION,
  KeepEngineApi,
  KeepProgress,
  KeepRules,
  KeepSnapshot,
  ScanEstimate,
  ScanPlan,
} from './types';

export interface KeepScanOptions {
  datasource: DataSourceRef;
  /** null = all providers of the organization, [] = none. */
  pids: string[] | null;
  engine: KeepEngineApi;
  mode: 'scan' | 'backtest';
  /** Scan: the as-of day (start of a UTC day). */
  asOf: number;
  /** Backtest: first and last as-of day (starts of UTC days). */
  backtest?: { from: number; to: number };
  /** Ask the backend for GA4 evidence of the at-risk accounts. */
  useBehavior: boolean;
  signal: AbortSignal;
  /** Wall clock (epoch seconds), for tests. */
  now?: number;
  onProgress?: (progress: KeepProgress) => void;
  onWarning?: (message: string) => void;
}

const DAY = 86400;
/**
 * Light days one run may read. A light statement still scans the whole UTC
 * day of the raw table (the provider is not in its sort key), so a long
 * subscription history or outcome horizon is as heavy on the cluster as it is
 * cheap in the browser.
 */
export const KEEP_MAX_LIGHT_DAYS = 90;
/** Full and light days together that one run may read. */
export const KEEP_MAX_RUN_DAYS = 150;
/** Accounts per backend request (the route accepts at most 5000). */
export const BEHAVIOR_BATCH = 2000;
/** The longest recent window the backend serves. */
const BEHAVIOR_MAX_RECENT_DAYS = 28;
/** The backend's account format: anything else would fail the whole batch. */
const BEHAVIOR_ACCOUNT_RE = /^[A-Z0-9]{4,24}$/;

const dayStart = (sec: number) => Math.floor(sec / DAY) * DAY;
/** `2026-10-08` (UTC). */
export const isoDay = (day: number) => new Date(day * 1000).toISOString().slice(0, 10);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function stopped(): Error {
  const error = new Error('The scan was stopped.');
  error.name = 'AbortError';
  return error;
}

/**
 * Rejects as soon as the signal aborts, whatever the wrapped promise does: a
 * read that answers after Stop must never reach the engine, or a new run on
 * the same engine could hold the same day twice.
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(stopped());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(stopped());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/** Lets the page paint the new phase before a long synchronous evaluation. */
const yieldToPage = (signal: AbortSignal) => abortable(new Promise<void>((resolve) => setTimeout(resolve, 0)), signal);

/** Start of the last UTC day that ended at least KEEP_DAY_SETTLE_SEC ago. */
export function lastCompleteDay(nowSec: number): number {
  return dayStart(nowSec - KEEP_DAY_SETTLE_SEC) - DAY;
}

/** Day starts from `from` to `to`, both included; empty when to < from. */
function dayRange(from: number, to: number): number[] {
  const out: number[] = [];
  for (let d = from; d <= to; d += DAY) {
    out.push(d);
  }
  return out;
}

/** The days a scan or a backtest needs. Throws with a readable message when the range is invalid. */
export function planScan(
  rules: KeepRules,
  mode: 'scan' | 'backtest',
  asOf: number,
  backtest: { from: number; to: number } | undefined,
  nowSec: number
): ScanPlan {
  // The engine's own day counts, so the days read and the windows it
  // evaluates always agree (7.5 recent days are 7, an outcome of 0 days is 1).
  const lookback = ruleDays(rules.recentDays) + ruleDays(rules.baselineDays);
  const history = ruleDays(rules.renewalHistoryDays);
  const lastComplete = lastCompleteDay(nowSec);
  const notComplete = (day: number) =>
    new Error(
      `${isoDay(day)} (UTC) is not complete yet: a day is read ${KEEP_DAY_SETTLE_SEC / 3600} h after it ends, ` +
        `so the latest day to choose is ${isoDay(lastComplete)}.`
    );

  let first: number;
  let last: number;
  let asOfs: number[];
  let after: number[] = [];
  if (mode === 'backtest') {
    if (!backtest || !Number.isFinite(backtest.from) || !Number.isFinite(backtest.to)) {
      throw new Error('Choose the first and the last as-of day of the backtest.');
    }
    first = dayStart(backtest.from);
    last = dayStart(backtest.to);
    if (first > last) {
      throw new Error(`The backtest starts on ${isoDay(first)}, after its end ${isoDay(last)}.`);
    }
    const outcome = ruleDays(rules.outcomeDays);
    const grace = graceDays(rules.labelGraceDays);
    const horizonEnd = last + (outcome + grace) * DAY;
    if (horizonEnd > lastComplete) {
      if (last > lastComplete) {
        throw notComplete(last);
      }
      throw new Error(
        `The backtest ends too late: each as-of day needs ${outcome} days of outcome and ${grace} days of grace ` +
          `after it, so the latest end is ${isoDay(lastComplete - (outcome + grace) * DAY)}.`
      );
    }
    asOfs = [];
    const step = ruleDays(rules.backtestStepDays) * DAY;
    for (let d = first; d <= last; d += step) {
      asOfs.push(d);
    }
    // The chosen end is always evaluated, even off the step grid: it is the
    // snapshot the page shows after the backtest.
    if (asOfs[asOfs.length - 1] !== last) {
      asOfs.push(last);
    }
    after = dayRange(last + DAY, horizonEnd);
  } else {
    if (!Number.isFinite(asOf)) {
      throw new Error('Choose the as-of day.');
    }
    first = last = dayStart(asOf);
    if (last > lastComplete) {
      throw notComplete(last);
    }
    asOfs = [last];
  }

  const full = dayRange(first - (lookback - 1) * DAY, last);
  if (full.length > KEEP_MAX_SCAN_DAYS) {
    throw new Error(
      `The run needs ${full.length} full days, more than ${KEEP_MAX_SCAN_DAYS}: ` +
        `shorten the backtest or the recent and baseline windows.`
    );
  }
  // Subscription history before the windows only needs the light query.
  const before = dayRange(first - (history - 1) * DAY, first - lookback * DAY);
  const light = [...before, ...after];
  if (light.length > KEEP_MAX_LIGHT_DAYS) {
    throw new Error(
      `The run needs ${light.length} light days, more than ${KEEP_MAX_LIGHT_DAYS}: shorten the subscription history` +
        (mode === 'backtest' ? ` or the backtest's outcome and grace days.` : '.')
    );
  }
  if (full.length + light.length > KEEP_MAX_RUN_DAYS) {
    throw new Error(
      `The run needs ${full.length + light.length} days (${full.length} full + ${light.length} light), ` +
        `more than ${KEEP_MAX_RUN_DAYS}: shorten the backtest, the windows or the subscription history.`
    );
  }
  return {
    full,
    light,
    asOfs,
    keepFrom: Math.min(full[0], before[0] ?? full[0]),
    keepTo: Math.max(full[full.length - 1], after[after.length - 1] ?? last),
  };
}

/** Cache identity of an engine: a different datasource or scope needs a new one. */
export function engineKey(datasourceUid: string, pids: string[] | null): string {
  const scope = pids === null ? '*' : Array.from(new Set(pids)).sort().join(',');
  return `${datasourceUid}|${scope}|v${KEEP_SQL_VERSION}`;
}

/** Size of the scan before it runs; null when the estimate is unavailable. */
export async function estimateScan(
  datasource: DataSourceRef,
  pids: string[] | null,
  plan: ScanPlan,
  signal: AbortSignal
): Promise<ScanEstimate | null> {
  const planDays = plan.full.length + plan.light.length;
  if (pids !== null && pids.length === 0) {
    return { perPid: [], accountsPerDay: 0, accountDays: 0, tooLarge: false };
  }
  // The latest day of the plan: complete (the plan checked it) and as large
  // as any other day of the run.
  const day = Math.max(...plan.full, ...plan.light);
  try {
    const rows = await abortable(
      queryRows(datasource, estimateSql(day, pids), { signal, retryDelaysMs: [3000], maxRows: 10000 }),
      signal
    );
    const perPid = rows
      .map((r) => ({ pid: str(r.pid), accounts: Math.max(0, num(r.accounts)) }))
      .filter((r) => r.pid !== '' && r.accounts > 0)
      .sort((a, b) => b.accounts - a.accounts);
    if (!perPid.length) {
      // Daily aggregates not built yet look exactly like an empty scope:
      // better no estimate than a reassuring zero.
      return null;
    }
    const accountsPerDay = perPid.reduce((sum, r) => sum + r.accounts, 0);
    const accountDays = accountsPerDay * planDays;
    return { perPid, accountsPerDay, accountDays, tooLarge: accountDays > KEEP_MAX_ACCOUNT_DAYS };
  } catch {
    // Best effort: without an estimate the scan is still allowed.
    return null;
  }
}

interface DayNeed {
  day: number;
  level: DayLevel;
}

async function readBlock(
  opts: KeepScanOptions,
  day: number,
  level: DayLevel,
  from: number,
  to: number
): Promise<DayBlock> {
  const frame = await abortable(
    // Gateway and network failures are retried; a timeout is not retried as
    // is (it would cost another full scan of the day and most likely time out
    // again): readDay splits the day instead.
    queryFrame(opts.datasource, accountDaysSql(from, to, opts.pids, level), {
      signal: opts.signal,
      isRetryable: isTransientNotTimeout,
    }),
    opts.signal
  );
  return blockFromFrame(day, level, frame, from, to);
}

/**
 * One day as one or two blocks. A day that runs out of the server's time is
 * read once more as two halves; both halves must arrive before either is
 * kept, so the engine never holds half a day.
 */
async function readDay(opts: KeepScanOptions, { day, level }: DayNeed): Promise<DayBlock[]> {
  const end = day + DAY;
  try {
    return [await readBlock(opts, day, level, day, end)];
  } catch (e) {
    if (opts.signal.aborted || !isTimeoutError(e)) {
      throw e;
    }
  }
  const mid = day + DAY / 2;
  try {
    const first = await readBlock(opts, day, level, day, mid);
    const second = await readBlock(opts, day, level, mid, end);
    return [first, second];
  } catch (e) {
    if (opts.signal.aborted) {
      throw e;
    }
    throw new Error(`it timed out, and failed again when read in two halves (${errorText(e)})`);
  }
}

/**
 * Reads the days the engine does not hold yet, oldest first, a few at a time.
 * Every day is kept as soon as it arrives; the first failure stops new reads,
 * waits for the ones in flight (their days are kept too) and names the day,
 * so a new run continues where this one stopped.
 */
async function readMissingDays(opts: KeepScanOptions, needs: DayNeed[], report: (p: KeepProgress) => void) {
  const { engine, signal } = opts;
  const missing = needs.filter((n) => !engine.hasDay(n.day, n.level));
  let done = needs.length - missing.length;
  let next = 0;
  const failures: Array<{ day: number; error: Error }> = [];
  report({ phase: 'days', done, total: needs.length, day: missing[0]?.day });

  const worker = async () => {
    while (!failures.length && next < missing.length && !signal.aborted) {
      const need = missing[next++];
      report({ phase: 'days', done, total: needs.length, day: need.day });
      try {
        const blocks = await readDay(opts, need);
        blocks.forEach((block) => engine.ingestDay(block));
        done += 1;
        report({ phase: 'days', done, total: needs.length, day: need.day });
      } catch (e) {
        if (signal.aborted) {
          return;
        }
        failures.push({
          day: need.day,
          error: new Error(
            `Could not read ${isoDay(need.day)} (UTC, ${need.level}): ${errorText(e)}. ` +
              `The days read so far are kept: running again continues from this day.`
          ),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(KEEP_PARALLEL_DAYS, missing.length) }, worker));
  if (signal.aborted) {
    throw stopped();
  }
  if (failures.length) {
    // The oldest failed day: the one a new run reads first.
    throw failures.reduce((a, b) => (b.day < a.day ? b : a)).error;
  }
}

/** Same words as the assistant client's answer for providers without a GA4 property. */
const NOT_LINKED_MESSAGE = 'GA4 is not linked to these providers.';

/** How bad a batch answer is: the merged result reports the worst one. */
const STATUS_RANK: Record<BehaviorStatusCode, number> = {
  on: 0,
  partial: 1,
  pending: 2,
  budget: 3,
  error: 4,
  off: 5,
  unavailable: 6,
};

/**
 * GA4 evidence of the snapshot's at-risk accounts, in batches the backend
 * accepts. A failed batch does not throw: the result carries the rows read so
 * far with status `error` and the reason (only Stop throws). Null when no
 * account needs evidence.
 */
export async function fetchBehaviorFor(
  snapshot: KeepSnapshot,
  recentDays: number,
  signal: AbortSignal,
  onBatch?: (done: number, total: number) => void
): Promise<BehaviorResult | null> {
  const seen = new Set<string>();
  const accounts: Array<{ pid: string; key: string }> = [];
  for (const a of snapshot.assessments) {
    const id = `${a.pid}|${a.accountKey}`;
    if (a.atRisk && BEHAVIOR_ACCOUNT_RE.test(a.accountKey) && !seen.has(id)) {
      seen.add(id);
      accounts.push({ pid: a.pid, key: a.accountKey });
    }
  }
  if (!accounts.length) {
    return null;
  }

  const batches: Array<Record<string, string[]>> = [];
  for (let i = 0; i < accounts.length; i += BEHAVIOR_BATCH) {
    const byPid: Record<string, string[]> = {};
    for (const { pid, key } of accounts.slice(i, i + BEHAVIOR_BATCH)) {
      (byPid[pid] ??= []).push(key);
    }
    batches.push(byPid);
  }

  const merged: BehaviorResult = { status: 'on', rows: [], matched: 0, requested: 0 };
  const rows: BehaviorRow[] = [];
  /**
   * The counts are the backend's own: `requested` covers only the accounts of
   * providers bound to a GA4 property, the rest are `notLinked`. The batch
   * size stands in only when an answer carries no count.
   */
  const merge = (part: BehaviorResult, size: number) => {
    rows.push(...part.rows);
    merged.requested = (merged.requested ?? 0) + (part.requested ?? size);
    merged.matched = (merged.matched ?? 0) + (part.matched ?? part.rows.length);
    if (part.notLinked !== undefined) {
      merged.notLinked = (merged.notLinked ?? 0) + part.notLinked;
    }
    merged.window ??= part.window;
    if (STATUS_RANK[part.status] > STATUS_RANK[merged.status]) {
      merged.status = part.status;
      merged.message = part.message;
    } else if (part.status === merged.status && !merged.message) {
      merged.message = part.message;
    }
  };

  const asOf = isoDay(snapshot.asOf);
  // The engine's recent window, so GA4 counts cover the same days as the rest.
  const days = Math.min(BEHAVIOR_MAX_RECENT_DAYS, ruleDays(recentDays));
  onBatch?.(0, batches.length);
  for (let i = 0; i < batches.length; i++) {
    const size = Object.values(batches[i]).reduce((sum, list) => sum + list.length, 0);
    try {
      const part = await abortable(
        fetchKeepBehavior({ asOf, recentDays: days, accountsByPid: batches[i] }, signal),
        signal
      );
      merge(part, size);
    } catch (e) {
      if (signal.aborted) {
        throw stopped();
      }
      merge({ status: 'error', rows: [], matched: 0, requested: size, message: errorText(e) }, size);
    }
    onBatch?.(i + 1, batches.length);
    // Off, pending, out of budget or failing: the next batch would get the same answer.
    if (merged.status !== 'on' && merged.status !== 'partial') {
      break;
    }
  }
  // Every batch answered, but none held a provider bound to GA4 (a batch of
  // unbound providers only is an empty "on"): for the page that is "off".
  if (merged.status === 'on' && merged.requested === 0 && (merged.notLinked ?? 0) > 0) {
    merged.status = 'off';
    merged.message = NOT_LINKED_MESSAGE;
  }
  return { ...merged, rows };
}

/**
 * The backtest one as-of date at a time when the engine offers it: the page
 * gets a turn between dates (progress, and "Stop" takes effect there). An
 * engine without it runs the whole backtest in one go.
 */
async function runBacktest(
  engine: KeepEngineApi,
  asOfs: number[],
  signal: AbortSignal,
  report: (p: KeepProgress) => void
): Promise<BacktestReport> {
  if (!engine.beginBacktest) {
    return engine.backtest(asOfs);
  }
  const session = engine.beginBacktest(asOfs);
  // One step per as-of date; the bound only guards against a session that never ends.
  for (let i = 0; i < session.total && session.done < session.total; i++) {
    if (i > 0) {
      await yieldToPage(signal);
    }
    const more = session.step();
    report({ phase: 'evaluate', done: session.done, total: session.total });
    if (!more) {
      break;
    }
  }
  return session.report();
}

/** Reads the missing days, evaluates the rules (and the backtest), adds GA4 evidence. */
export async function runKeepScan(opts: KeepScanOptions): Promise<KeepSnapshot> {
  const { engine, signal } = opts;
  const clock = () => opts.now ?? Math.floor(Date.now() / 1000);
  const now = clock();
  const report = (progress: KeepProgress) => opts.onProgress?.(progress);
  if (signal.aborted) {
    throw stopped();
  }
  if (opts.pids !== null && opts.pids.length === 0) {
    throw new Error('No providers are in scope: there is nothing to scan.');
  }

  const plan = planScan(engine.rules, opts.mode, opts.asOf, opts.backtest, now);
  const needs: DayNeed[] = [
    ...plan.full.map((day): DayNeed => ({ day, level: 'full' })),
    ...plan.light.map((day): DayNeed => ({ day, level: 'light' })),
  ].sort((a, b) => a.day - b.day);
  // planScan already refuses such ranges; an unfinished day must never be
  // read, since the engine would keep it as if it were complete.
  const unfinished = needs.find((n) => n.day + DAY + KEEP_DAY_SETTLE_SEC > now);
  if (unfinished) {
    throw new Error(`${isoDay(unfinished.day)} (UTC) is not complete yet.`);
  }

  engine.evictOutside(plan.keepFrom, plan.keepTo);
  await readMissingDays(opts, needs, report);

  report({ phase: 'evaluate', done: 0, total: plan.asOfs.length });
  await yieldToPage(signal);
  // Evidence of an earlier run belongs to another as-of day (or scope).
  engine.setBehavior(null);
  const asOf = plan.asOfs[plan.asOfs.length - 1];
  let backtest: BacktestReport | undefined;
  if (opts.mode === 'backtest') {
    backtest = await runBacktest(engine, plan.asOfs, signal, report);
    // The snapshot of the last date is one more evaluation.
    await yieldToPage(signal);
  }
  // The jobs on screen go out after this run, never before the as-of day was
  // complete: send times and renewal steps start there, not at the day's end.
  // (Each backtest date is handled inside the engine.)
  const notBefore = Math.max(clock(), asOf + DAY + KEEP_DAY_SETTLE_SEC);
  const evaluate = (): KeepSnapshot => {
    const snapshot = engine.evaluate(asOf, { notBefore });
    return backtest ? { ...snapshot, backtest } : snapshot;
  };
  let snapshot = evaluate();

  if (opts.useBehavior) {
    report({ phase: 'behavior', done: 0, total: 1 });
    const behavior = await fetchBehaviorFor(snapshot, engine.rules.recentDays, signal, (done, total) =>
      report({ phase: 'behavior', done, total })
    );
    if (behavior) {
      if (behavior.status === 'error') {
        opts.onWarning?.(
          `GA4 evidence could not be read${behavior.message ? ` (${behavior.message})` : ''}: ` +
            `accounts without it are judged on Analytix data only.`
        );
      }
      engine.setBehavior(behavior);
      await yieldToPage(signal);
      snapshot = evaluate();
    }
  }

  // A "Stop" that arrived during the last synchronous evaluation wins over its result.
  if (signal.aborted) {
    throw stopped();
  }
  report({ phase: 'done', done: needs.length, total: needs.length });
  return snapshot;
}
