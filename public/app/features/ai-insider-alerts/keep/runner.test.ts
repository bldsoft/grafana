import { KeepEngine } from './engine';
import {
  engineKey,
  estimateScan,
  BEHAVIOR_BATCH,
  fetchBehaviorFor,
  lastCompleteDay,
  planScan,
  runKeepScan,
  KEEP_MAX_LIGHT_DAYS,
  KEEP_MAX_RUN_DAYS,
  KeepScanOptions,
} from './runner';
import {
  AccountAssessment,
  AccountDayRow,
  BacktestReport,
  BacktestSession,
  BehaviorResult,
  DayBlock,
  DayLevel,
  DEFAULT_KEEP_RULES,
  EvaluateOptions,
  FrameLike,
  KEEP_DAY_SETTLE_SEC,
  KEEP_PARALLEL_DAYS,
  KEEP_SQL_VERSION,
  KeepEngineApi,
  KeepProgress,
  KeepRules,
  KeepSnapshot,
} from './types';

const queryFrame = jest.fn();
const queryRows = jest.fn();
const fetchKeepBehavior = jest.fn();

jest.mock('../query', () => {
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const isTimeoutError = (e: unknown) => /TIMEOUT_EXCEEDED|did not answer/.test(message(e));
  return {
    queryFrame: (...args: unknown[]) => queryFrame(...args),
    queryRows: (...args: unknown[]) => queryRows(...args),
    isTimeoutError,
    isTransientNotTimeout: (e: unknown) => /\b50[234]\b|did not answer/.test(message(e)) && !isTimeoutError(e),
  };
});

jest.mock('./sql', () => ({
  accountDaysSql: (from: number, to: number, pids: string[] | null, level: string) =>
    `days ${level} ${from} ${to} ${pids === null ? '*' : pids.join(',')}`,
  estimateSql: (day: number, pids: string[] | null) => `estimate ${day} ${pids === null ? '*' : pids.join(',')}`,
}));

jest.mock('app/features/dashboard-scene/ai-panel/assistantClient', () => ({
  fetchKeepBehavior: (...args: unknown[]) => fetchKeepBehavior(...args),
}));

const DAY = 86400;
const DS = { uid: 'ch', type: 'grafana-clickhouse-datasource' };
const utcDay = (m: number, d: number) => Date.UTC(2026, m - 1, d) / 1000;
/** 10 Oct 2026 06:00 UTC: the last complete day is 9 Oct. */
const NOW = Date.UTC(2026, 9, 10, 6) / 1000;
const D = utcDay(10, 9);
/** Four full days and two light ones, so runs stay readable. */
const SMALL: KeepRules = { ...DEFAULT_KEEP_RULES, recentDays: 2, baselineDays: 2, renewalHistoryDays: 6 };

/** What a day-statement mock was asked for, from the recognisable SQL of the mocked ./sql. */
function parseDaySql(sql: string) {
  const [, level, from, to] = sql.split(' ');
  return { level, from: Number(from), to: Number(to) };
}

function snapshotOf(asOf: number, assessments: AccountAssessment[], behavior: BehaviorResult | null): KeepSnapshot {
  return {
    asOf,
    pids: ['111'],
    assessments,
    jobs: [],
    renewals: [],
    leads: [],
    support: [],
    quality: {
      accounts: assessments.length,
      eligible: assessments.length,
      legacyOnly: 0,
      planUnknown: 0,
      expiryUnknown: 0,
      noEnd: 0,
      plans: [],
      renewalStyles: { at_term: 0, early: 0, repurchase: 0, unknown: 0 },
      paywall: [],
      days: [],
      missingDays: [],
      behavior: behavior ?? undefined,
    },
    mdePct: null,
  };
}

/** Records what the runner does with the engine; holds days like the real one (full covers light). */
class FakeEngine implements KeepEngineApi {
  held = new Map<number, { level: DayLevel; blocks: DayBlock[] }>();
  ingested: DayBlock[] = [];
  evicted: Array<[number, number]> = [];
  behaviorLog: Array<BehaviorResult | null> = [];
  evaluated: number[] = [];
  evaluateOptions: Array<EvaluateOptions | undefined> = [];
  backtests: number[][] = [];
  backtestOptions: Array<EvaluateOptions | undefined> = [];
  assessments: AccountAssessment[] = [];
  /** Called inside evaluate / backtest: what a click handled right after them would do. */
  onEvaluate?: () => void;
  onBacktest?: () => void;
  private behavior: BehaviorResult | null = null;

  constructor(readonly rules: KeepRules = SMALL) {}

  hasDay(day: number, level: DayLevel): boolean {
    const held = this.held.get(day);
    return !!held && (held.level === 'full' || held.level === level);
  }
  ingestDay(block: DayBlock): void {
    this.ingested.push(block);
    const held = this.held.get(block.day);
    if (held && held.level === block.level) {
      held.blocks.push(block);
    } else {
      this.held.set(block.day, { level: block.level, blocks: [block] });
    }
  }
  evictOutside(from: number, to: number): void {
    this.evicted.push([from, to]);
    for (const day of Array.from(this.held.keys())) {
      if (day < from || day > to) {
        this.held.delete(day);
      }
    }
  }
  setBehavior(result: BehaviorResult | null): void {
    this.behavior = result;
    this.behaviorLog.push(result);
  }
  evaluate(asOf: number, opts?: EvaluateOptions): KeepSnapshot {
    this.evaluated.push(asOf);
    this.evaluateOptions.push(opts);
    this.onEvaluate?.();
    return snapshotOf(asOf, this.assessments, this.behavior);
  }
  backtest(asOfs: number[], opts?: EvaluateOptions): BacktestReport {
    this.backtests.push(asOfs);
    this.backtestOptions.push(opts);
    this.onBacktest?.();
    return { asOfs, horizonDays: this.rules.outcomeDays, rows: [], suppressedByCooldown: 0 };
  }
  days() {
    return Array.from(this.held.entries()).map(([day, h]) => ({ day, level: h.level, rows: h.blocks.length }));
  }
}

/** An engine that offers the backtest one as-of date at a time. */
class SteppingEngine extends FakeEngine {
  steps: number[] = [];
  sessions: number[][] = [];

  beginBacktest(asOfs: number[]): BacktestSession {
    this.sessions.push(asOfs);
    const steps = this.steps;
    let done = 0;
    return {
      total: asOfs.length,
      get done() {
        return done;
      },
      step: () => {
        if (done >= asOfs.length) {
          return false;
        }
        steps.push(asOfs[done++]);
        return done < asOfs.length;
      },
      report: () => ({ asOfs: asOfs.slice(0, done), horizonDays: 2, rows: [], suppressedByCooldown: 0 }),
    };
  }
}

function assessment(pid: string, accountKey: string, atRisk = true): AccountAssessment {
  return { key: `${pid}|${accountKey}`, pid, account: accountKey, accountKey, atRisk } as AccountAssessment;
}

function scan(engine: KeepEngineApi, extra: Partial<KeepScanOptions> = {}): Promise<KeepSnapshot> {
  return runKeepScan({
    datasource: DS,
    pids: ['111'],
    engine,
    mode: 'scan',
    asOf: D,
    useBehavior: false,
    signal: new AbortController().signal,
    now: NOW,
    ...extra,
  });
}

const readDays = () => queryFrame.mock.calls.map((call) => parseDaySql(call[1]));

beforeEach(() => {
  queryFrame.mockReset();
  queryRows.mockReset();
  fetchKeepBehavior.mockReset();
  queryFrame.mockImplementation((_ds: unknown, sql: string) => Promise.resolve({ length: 3, sql }));
});

describe('lastCompleteDay', () => {
  it('is the last UTC day that ended at least three hours ago', () => {
    expect(lastCompleteDay(Date.UTC(2026, 9, 10, 2, 59, 59) / 1000)).toBe(utcDay(10, 8));
    expect(lastCompleteDay(Date.UTC(2026, 9, 10, 3) / 1000)).toBe(utcDay(10, 9));
    expect(lastCompleteDay(NOW)).toBe(D);
  });
});

describe('planScan', () => {
  it('reads the windows in full and the rest of the renewal history light', () => {
    const plan = planScan(DEFAULT_KEEP_RULES, 'scan', D, undefined, NOW);
    expect(plan.full).toHaveLength(28);
    expect(plan.full[0]).toBe(D - 27 * DAY);
    expect(plan.full[27]).toBe(D);
    expect(plan.light).toHaveLength(12);
    expect(plan.light[0]).toBe(D - 39 * DAY);
    expect(plan.light[11]).toBe(D - 28 * DAY);
    expect(plan.asOfs).toEqual([D]);
    expect(plan.keepFrom).toBe(D - 39 * DAY);
    expect(plan.keepTo).toBe(D);
  });

  it('needs no light days when the history fits in the windows', () => {
    const plan = planScan({ ...DEFAULT_KEEP_RULES, renewalHistoryDays: 20 }, 'scan', D, undefined, NOW);
    expect(plan.full).toHaveLength(28);
    expect(plan.light).toEqual([]);
    expect(plan.keepFrom).toBe(D - 27 * DAY);
  });

  it('plans a backtest: full days for every as-of, light history before and the outcome horizon after', () => {
    const from = utcDay(8, 25);
    const to = utcDay(9, 8);
    const plan = planScan(DEFAULT_KEEP_RULES, 'backtest', 0, { from, to }, NOW);
    expect(plan.asOfs).toEqual([from, from + 7 * DAY, to]);
    expect(plan.full[0]).toBe(from - 27 * DAY);
    expect(plan.full[plan.full.length - 1]).toBe(to);
    expect(plan.full).toHaveLength(42);
    const before = plan.light.filter((d) => d < from);
    const after = plan.light.filter((d) => d > to);
    expect(before).toHaveLength(12);
    expect(before[0]).toBe(from - 39 * DAY);
    // Outcome 21 days + grace 7 days after the last as-of.
    expect(after).toHaveLength(28);
    expect(after[0]).toBe(to + DAY);
    expect(after[27]).toBe(to + 28 * DAY);
    expect(plan.keepFrom).toBe(from - 39 * DAY);
    expect(plan.keepTo).toBe(to + 28 * DAY);
  });

  it('always evaluates the chosen end of a backtest, even off the step grid', () => {
    const from = utcDay(8, 25);
    const plan = planScan(DEFAULT_KEEP_RULES, 'backtest', 0, { from, to: utcDay(9, 10) }, NOW);
    expect(plan.asOfs).toEqual([from, utcDay(9, 1), utcDay(9, 8), utcDay(9, 10)]);
  });

  it('refuses ranges it cannot read with a readable message', () => {
    expect(() => planScan(DEFAULT_KEEP_RULES, 'scan', D + DAY, undefined, NOW)).toThrow(
      '2026-10-10 (UTC) is not complete yet'
    );
    expect(() => planScan(DEFAULT_KEEP_RULES, 'backtest', 0, { from: utcDay(9, 1), to: utcDay(9, 20) }, NOW)).toThrow(
      'the latest end is 2026-09-11'
    );
    expect(() => planScan(DEFAULT_KEEP_RULES, 'backtest', 0, { from: utcDay(9, 8), to: utcDay(9, 1) }, NOW)).toThrow(
      'after its end 2026-09-01'
    );
    expect(() => planScan(DEFAULT_KEEP_RULES, 'backtest', 0, { from: utcDay(6, 1), to: utcDay(9, 8) }, NOW)).toThrow(
      'more than 80'
    );
    expect(() => planScan(DEFAULT_KEEP_RULES, 'backtest', 0, undefined, NOW)).toThrow('Choose');
  });

  it('caps the light days and all days of a run, with a readable message', () => {
    // A year of subscription history: hundreds of whole-day scans of the raw table.
    expect(() => planScan({ ...DEFAULT_KEEP_RULES, renewalHistoryDays: 400 }, 'scan', D, undefined, NOW)).toThrow(
      `The run needs 372 light days, more than ${KEEP_MAX_LIGHT_DAYS}: shorten the subscription history.`
    );
    // A long outcome horizon after a backtest.
    expect(() =>
      planScan(
        { ...DEFAULT_KEEP_RULES, outcomeDays: 90, labelGraceDays: 14 },
        'backtest',
        0,
        { from: utcDay(5, 20), to: utcDay(5, 27) },
        NOW
      )
    ).toThrow(`more than ${KEEP_MAX_LIGHT_DAYS}: shorten the subscription history or the backtest's outcome and grace`);
    // 80 full + 90 light days: each cap holds, together they are too many.
    const from = utcDay(7, 1);
    const plan = () =>
      planScan({ ...DEFAULT_KEEP_RULES, renewalHistoryDays: 90 }, 'backtest', 0, { from, to: from + 52 * DAY }, NOW);
    expect(() => plan()).toThrow(`The run needs 170 days (80 full + 90 light), more than ${KEEP_MAX_RUN_DAYS}`);
    // The defaults stay well inside.
    expect(planScan(DEFAULT_KEEP_RULES, 'backtest', 0, { from, to: from + 52 * DAY }, NOW).light).toHaveLength(40);
  });

  it('counts rule days the way the engine does (whole days, an outcome of at least one)', () => {
    // 7.5 recent days are 7 for the engine: 28 full days, not 29.
    const fractional = planScan({ ...DEFAULT_KEEP_RULES, recentDays: 7.5 }, 'scan', D, undefined, NOW);
    expect(fractional.full).toHaveLength(28);
    expect(fractional.full[0]).toBe(D - 27 * DAY);
    // An outcome of 0 days is a 1-day horizon for the engine: that day is read,
    // so a backtest cannot end on the last complete day.
    const none = { ...DEFAULT_KEEP_RULES, outcomeDays: 0, labelGraceDays: 0 };
    expect(() => planScan(none, 'backtest', 0, { from: D - 7 * DAY, to: D }, NOW)).toThrow(
      'the latest end is 2026-10-08'
    );
    const plan = planScan(none, 'backtest', 0, { from: D - 7 * DAY, to: D - DAY }, NOW);
    expect(plan.light.filter((d) => d > D - DAY)).toEqual([D]);
    // Grace days are whole days too (2.7 → 2).
    const grace = planScan(
      { ...none, outcomeDays: 1.9, labelGraceDays: 2.7 },
      'backtest',
      0,
      { from: D - 10 * DAY, to: D - 3 * DAY },
      NOW
    );
    expect(grace.light.filter((d) => d > D - 3 * DAY)).toEqual([D - 2 * DAY, D - DAY, D]);
  });
});

describe('engineKey', () => {
  it('changes with the datasource, the scope and the SQL version only', () => {
    expect(engineKey('ch', ['222', '111', '111'])).toBe(`ch|111,222|v${KEEP_SQL_VERSION}`);
    expect(engineKey('ch', ['111', '222'])).toBe(engineKey('ch', ['222', '111']));
    expect(engineKey('ch', null)).toBe(`ch|*|v${KEEP_SQL_VERSION}`);
    expect(engineKey('other', ['111'])).not.toBe(engineKey('ch', ['111']));
  });
});

describe('runKeepScan: days', () => {
  it('reads the missing days oldest first, a few at a time, and evaluates the as-of day', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    queryFrame.mockImplementation(async (_ds: unknown, sql: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return { length: 3, sql };
    });
    const engine = new FakeEngine();
    const progress: KeepProgress[] = [];
    const snapshot = await scan(engine, { onProgress: (p) => progress.push(p) });

    expect(readDays()).toEqual([
      { level: 'light', from: D - 5 * DAY, to: D - 4 * DAY },
      { level: 'light', from: D - 4 * DAY, to: D - 3 * DAY },
      { level: 'full', from: D - 3 * DAY, to: D - 2 * DAY },
      { level: 'full', from: D - 2 * DAY, to: D - DAY },
      { level: 'full', from: D - DAY, to: D },
      { level: 'full', from: D, to: D + DAY },
    ]);
    expect(maxInFlight).toBe(KEEP_PARALLEL_DAYS);
    expect(engine.evicted).toEqual([[D - 5 * DAY, D]]);
    expect(engine.days()).toHaveLength(6);
    expect(engine.evaluated).toEqual([D]);
    expect(engine.behaviorLog).toEqual([null]);
    expect(snapshot.asOf).toBe(D);
    expect(progress.map((p) => p.phase)).toEqual(expect.arrayContaining(['days', 'evaluate', 'done']));
    expect(progress.filter((p) => p.phase === 'days').pop()).toMatchObject({ done: 6, total: 6 });
    expect(progress[progress.length - 1].phase).toBe('done');
    // Gateway failures are retried, a timeout never as is.
    const options = queryFrame.mock.calls[0][2];
    expect(options.isRetryable(new Error('502 Bad Gateway'))).toBe(true);
    expect(options.isRetryable(new Error('Code: 159. DB::Exception: Timeout exceeded (TIMEOUT_EXCEEDED)'))).toBe(false);
    expect(options.isRetryable(new Error('The datasource did not answer within 55s.'))).toBe(false);
    expect(options.signal).toBeDefined();
  });

  it('reuses the days it holds: a later as-of reads only the new day, an earlier one upgrades light days', async () => {
    const engine = new FakeEngine();
    await scan(engine);
    expect(queryFrame).toHaveBeenCalledTimes(6);

    queryFrame.mockClear();
    await scan(engine);
    expect(queryFrame).not.toHaveBeenCalled();
    expect(engine.evaluated).toEqual([D, D]);

    queryFrame.mockClear();
    await scan(engine, { asOf: D + DAY, now: NOW + DAY });
    expect(readDays()).toEqual([{ level: 'full', from: D + DAY, to: D + 2 * DAY }]);
    // The oldest light day fell out of the new history.
    expect(engine.held.has(D - 5 * DAY)).toBe(false);

    queryFrame.mockClear();
    await scan(engine, { asOf: D - DAY, now: NOW + DAY });
    expect(readDays()).toEqual([
      { level: 'light', from: D - 6 * DAY, to: D - 5 * DAY },
      { level: 'light', from: D - 5 * DAY, to: D - 4 * DAY },
      // Held light so far, now inside the baseline.
      { level: 'full', from: D - 4 * DAY, to: D - 3 * DAY },
    ]);
    expect(engine.held.has(D + DAY)).toBe(false);
  });

  it('reads a day that times out once more as two halves of the same day', async () => {
    queryFrame.mockImplementation((_ds: unknown, sql: string) => {
      const { from, to } = parseDaySql(sql);
      if (from === D - DAY && to === D) {
        return Promise.reject(new Error('Code: 159. DB::Exception: Timeout exceeded (TIMEOUT_EXCEEDED)'));
      }
      return Promise.resolve({ length: 2, sql });
    });
    const engine = new FakeEngine();
    await scan(engine);

    const blocks = engine.held.get(D - DAY)?.blocks ?? [];
    expect(blocks.map((b) => [b.day, b.level, b.from, b.to])).toEqual([
      [D - DAY, 'full', D - DAY, D - DAY / 2],
      [D - DAY, 'full', D - DAY / 2, D],
    ]);
    expect(engine.days()).toHaveLength(6);
  });

  it('stops on a day that fails, names it, and a new run continues from the days already read', async () => {
    queryFrame.mockImplementation((_ds: unknown, sql: string) =>
      parseDaySql(sql).from === D - 2 * DAY
        ? Promise.reject(new Error('Code: 241. DB::Exception: Memory limit exceeded'))
        : Promise.resolve({ length: 1, sql })
    );
    const engine = new FakeEngine();
    await expect(scan(engine)).rejects.toThrow('Could not read 2026-10-07 (UTC, full): Code: 241');
    expect(engine.evaluated).toEqual([]);
    expect(engine.held.has(D - 2 * DAY)).toBe(false);
    const heldBefore = engine.days().length;
    expect(heldBefore).toBeGreaterThanOrEqual(3);
    // No half-day fallback for errors that are not timeouts.
    expect(readDays().filter((r) => r.to - r.from !== DAY)).toEqual([]);

    queryFrame.mockClear();
    queryFrame.mockImplementation((_ds: unknown, sql: string) => Promise.resolve({ length: 1, sql }));
    await scan(engine);
    expect(queryFrame).toHaveBeenCalledTimes(6 - heldBefore);
    expect(readDays()[0]).toEqual({ level: 'full', from: D - 2 * DAY, to: D - DAY });
    expect(engine.days()).toHaveLength(6);
    expect(engine.evaluated).toEqual([D]);
  });

  it('names the day when its halves fail too, and keeps no half of it', async () => {
    queryFrame.mockImplementation((_ds: unknown, sql: string) => {
      const { from } = parseDaySql(sql);
      if (from >= D - DAY && from < D) {
        return Promise.reject(new Error('The datasource did not answer within 55s.'));
      }
      return Promise.resolve({ length: 1, sql });
    });
    const engine = new FakeEngine();
    await expect(scan(engine)).rejects.toThrow(/Could not read 2026-10-08 \(UTC, full\): it timed out.*two halves/);
    expect(engine.held.has(D - DAY)).toBe(false);
  });

  it('stops at once on abort and keeps nothing that answers afterwards', async () => {
    let release: (() => void) | undefined;
    queryFrame.mockImplementation(
      (_ds: unknown, sql: string) =>
        new Promise((resolve) => {
          release = () => resolve({ length: 1, sql });
        })
    );
    const controller = new AbortController();
    const engine = new FakeEngine();
    const run = scan(engine, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queryFrame).toHaveBeenCalledTimes(KEEP_PARALLEL_DAYS);
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.ingested).toEqual([]);
    expect(engine.evaluated).toEqual([]);
    expect(queryFrame).toHaveBeenCalledTimes(KEEP_PARALLEL_DAYS);
  });

  it('does nothing when stopped before it starts', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(scan(new FakeEngine(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(queryFrame).not.toHaveBeenCalled();
  });

  it('never reads a day that is not complete', async () => {
    const engine = new FakeEngine();
    // 02:00 UTC: 9 Oct ended only two hours ago.
    await expect(scan(engine, { now: Date.UTC(2026, 9, 10, 2) / 1000 })).rejects.toThrow(
      '2026-10-09 (UTC) is not complete yet'
    );
    expect(queryFrame).not.toHaveBeenCalled();
    expect(engine.evicted).toEqual([]);
  });

  it('refuses an empty provider scope', async () => {
    await expect(scan(new FakeEngine(), { pids: [] })).rejects.toThrow('No providers');
    expect(queryFrame).not.toHaveBeenCalled();
  });

  it('runs the backtest over every as-of day and shows the last one', async () => {
    const rules: KeepRules = { ...SMALL, outcomeDays: 2, labelGraceDays: 1, backtestStepDays: 2 };
    const engine = new FakeEngine(rules);
    const from = D - 9 * DAY;
    const to = D - 3 * DAY;
    const snapshot = await scan(engine, { mode: 'backtest', backtest: { from, to } });

    expect(engine.backtests).toEqual([[from, from + 2 * DAY, from + 4 * DAY, to]]);
    expect(engine.evaluated).toEqual([to]);
    expect(snapshot.backtest).toEqual({
      asOfs: engine.backtests[0],
      horizonDays: 2,
      rows: [],
      suppressedByCooldown: 0,
    });
    // History before the first window, full days through the end, the horizon after it.
    const days = readDays();
    expect(days[0]).toEqual({ level: 'light', from: from - 5 * DAY, to: from - 4 * DAY });
    expect(days.filter((d) => d.level === 'full')).toHaveLength(10);
    expect(days.filter((d) => d.level === 'light' && d.from > to)).toHaveLength(3);
  });
});

describe('runKeepScan: evaluation', () => {
  it('never lets a send time fall before the scan: notBefore is now, at least the as-of day end plus the settle time', async () => {
    const engine = new FakeEngine();
    await scan(engine);
    expect(engine.evaluateOptions).toEqual([{ notBefore: NOW }]);
    expect(NOW).toBeGreaterThanOrEqual(D + DAY + KEEP_DAY_SETTLE_SEC);

    // An older as-of day: still now, not that day's end.
    await scan(engine, { asOf: D - 3 * DAY });
    expect(engine.evaluateOptions[1]).toEqual({ notBefore: NOW });

    // The wall clock at evaluation time, not at the start of a long read.
    const later = new FakeEngine();
    const spy = jest.spyOn(Date, 'now');
    spy.mockReturnValue(NOW * 1000);
    queryFrame.mockImplementation(async (_ds: unknown, sql: string) => {
      spy.mockReturnValue((NOW + 1800) * 1000);
      return { length: 1, sql };
    });
    try {
      await runKeepScan({
        datasource: DS,
        pids: ['111'],
        engine: later,
        mode: 'scan',
        asOf: D,
        useBehavior: false,
        signal: new AbortController().signal,
      });
    } finally {
      spy.mockRestore();
    }
    expect(later.evaluateOptions).toEqual([{ notBefore: NOW + 1800 }]);
  });

  it('gives the backtest dates to the engine as they are and floors only the final snapshot', async () => {
    const rules: KeepRules = { ...SMALL, outcomeDays: 2, labelGraceDays: 1 };
    const engine = new FakeEngine(rules);
    await scan(engine, { mode: 'backtest', backtest: { from: D - 9 * DAY, to: D - 3 * DAY } });
    expect(engine.backtestOptions).toEqual([undefined]);
    // The snapshot of a past as-of day: its jobs could go out now at the earliest.
    expect(engine.evaluated).toEqual([D - 3 * DAY]);
    expect(engine.evaluateOptions).toEqual([{ notBefore: NOW }]);
  });

  it('runs the backtest one as-of date at a time when the engine offers it, with progress', async () => {
    const rules: KeepRules = { ...SMALL, outcomeDays: 2, labelGraceDays: 1, backtestStepDays: 2 };
    const engine = new SteppingEngine(rules);
    const from = D - 9 * DAY;
    const to = D - 3 * DAY;
    const progress: KeepProgress[] = [];
    let turns = 0;
    const snapshot = await scan(engine, {
      mode: 'backtest',
      backtest: { from, to },
      onProgress: (p) => {
        progress.push(p);
        if (p.phase === 'evaluate' && p.done > 0) {
          // The page gets a turn after every date: a timer set now fires before the next one.
          setTimeout(() => turns++, 0);
          expect(turns).toBe(p.done - 1);
        }
      },
    });

    const dates = [from, from + 2 * DAY, from + 4 * DAY, to];
    expect(engine.sessions).toEqual([dates]);
    expect(engine.steps).toEqual(dates);
    expect(engine.backtests).toEqual([]);
    expect(snapshot.backtest?.asOfs).toEqual(dates);
    expect(engine.evaluated).toEqual([to]);
    expect(progress.filter((p) => p.phase === 'evaluate').map((p) => [p.done, p.total])).toEqual([
      [0, 4],
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 4],
    ]);
  });

  it('stops between backtest dates', async () => {
    const rules: KeepRules = { ...SMALL, outcomeDays: 2, labelGraceDays: 1, backtestStepDays: 2 };
    const engine = new SteppingEngine(rules);
    const controller = new AbortController();
    const run = scan(engine, {
      mode: 'backtest',
      backtest: { from: D - 9 * DAY, to: D - 3 * DAY },
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === 'evaluate' && p.done === 1) {
          controller.abort();
        }
      },
    });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(engine.steps).toEqual([D - 9 * DAY]);
    expect(engine.evaluated).toEqual([]);
  });

  it('never returns a result after Stop, even when the stop arrives during a synchronous evaluation', async () => {
    // An engine without steps: the whole backtest in one go.
    const controller = new AbortController();
    const engine = new FakeEngine({ ...SMALL, outcomeDays: 2, labelGraceDays: 1 });
    engine.onBacktest = () => controller.abort();
    await expect(
      scan(engine, { mode: 'backtest', backtest: { from: D - 9 * DAY, to: D - 3 * DAY }, signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(engine.backtests).toHaveLength(1);
    expect(engine.evaluated).toEqual([]);

    // The scan's own (last) evaluation.
    const stop = new AbortController();
    const scanned = new FakeEngine();
    scanned.onEvaluate = () => stop.abort();
    await expect(scan(scanned, { signal: stop.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(scanned.evaluated).toEqual([D]);
  });
});

describe('runKeepScan with the real engine', () => {
  /** A datasource frame in its own columnar form, from row objects. */
  function frameOf(rows: Array<Partial<AccountDayRow>>): FrameLike {
    const names = Array.from(new Set(rows.flatMap((row) => Object.keys(row)))) as Array<keyof AccountDayRow>;
    return { length: rows.length, fields: names.map((name) => ({ name, values: rows.map((row) => row[name]) })) };
  }

  /** One account on every day: 10 events, 30 minutes and (full days only) 2 playbacks per whole day. */
  function rowsFor(level: DayLevel, from: number, to: number): Array<Partial<AccountDayRow>> {
    const share = (to - from) / DAY;
    const light: Partial<AccountDayRow> = {
      pid: '111',
      account: 'A1',
      events: 10 * share,
      legacy_events: 0,
      gated_plays: 2 * share,
      ungated_plays: 0,
      watch_all_min: 30 * share,
      expired_events: 0,
      inactive_attempts: 0,
      plan: 'Premium',
      first_ts: from + 600,
      last_ts: from + 3600,
      platforms: 'android',
    };
    return [level === 'full' ? { ...light, playbacks: 2 * share, watch_min: 30 * share, failed_playbacks: 0 } : light];
  }

  it('upgrades the light outcome days of a backtest to full for a scan, and joins a day read in halves', async () => {
    const rules: KeepRules = {
      ...DEFAULT_KEEP_RULES,
      recentDays: 2,
      baselineDays: 2,
      renewalHistoryDays: 6,
      minBaselineActiveDays: 1,
      outcomeDays: 2,
      labelGraceDays: 1,
    };
    queryFrame.mockImplementation((_ds: unknown, sql: string) => {
      const { level, from, to } = parseDaySql(sql);
      // The whole of 8 Oct read in full runs out of the server's time.
      if (level === 'full' && from === D - DAY && to === D) {
        return Promise.reject(new Error('Code: 159. DB::Exception: Timeout exceeded (TIMEOUT_EXCEEDED)'));
      }
      return Promise.resolve(frameOf(rowsFor(level === 'full' ? 'full' : 'light', from, to)));
    });
    const engine = new KeepEngine(rules);

    // Backtest on 6 Oct: its outcome horizon (7-9 Oct) is read light.
    const backtested = await scan(engine, {
      mode: 'backtest',
      backtest: { from: D - 3 * DAY, to: D - 3 * DAY },
    });
    expect(backtested.backtest?.asOfs).toEqual([D - 3 * DAY]);
    expect(engine.days().map((d) => [d.day, d.level, d.rows])).toEqual([
      [D - 8 * DAY, 'light', 1],
      [D - 7 * DAY, 'light', 1],
      [D - 6 * DAY, 'full', 1],
      [D - 5 * DAY, 'full', 1],
      [D - 4 * DAY, 'full', 1],
      [D - 3 * DAY, 'full', 1],
      [D - 2 * DAY, 'light', 1],
      [D - DAY, 'light', 1],
      [D, 'light', 1],
    ]);

    // Scan on 9 Oct: the recent and baseline windows now cover the light days.
    queryFrame.mockClear();
    const snapshot = await scan(engine);
    const reads = readDays().sort((a, b) => a.from - b.from || a.to - b.to);
    expect(reads).toEqual([
      { level: 'full', from: D - 2 * DAY, to: D - DAY },
      { level: 'full', from: D - DAY, to: D - DAY / 2 },
      { level: 'full', from: D - DAY, to: D },
      { level: 'full', from: D - DAY / 2, to: D },
      { level: 'full', from: D, to: D + DAY },
    ]);
    // Every day once, every one full: the upgrade replaced the light day, the halves joined.
    expect(engine.days().map((d) => [d.day, d.level, d.rows])).toEqual([
      [D - 5 * DAY, 'full', 1],
      [D - 4 * DAY, 'full', 1],
      [D - 3 * DAY, 'full', 1],
      [D - 2 * DAY, 'full', 1],
      [D - DAY, 'full', 1],
      [D, 'full', 1],
    ]);
    expect(snapshot.quality.missingDays).toEqual([]);

    // ...and counted once: no light row left under a full one, no half missing.
    const a1 = snapshot.assessments.find((a) => a.key === '111|A1');
    expect(a1?.dailyWatch).toEqual([30, 30, 30, 30]);
    expect(a1?.recent).toMatchObject({ activeDays: 2, events: 20, watchAllMin: 60, playbacks: 4 });
    expect(a1?.baseline).toMatchObject({ activeDays: 2, events: 20, watchAllMin: 60, playbacks: 4 });
  });
});

describe('runKeepScan: GA4 evidence', () => {
  const onRows = (pid: string, account: string) => ({
    pid,
    account,
    days: 2,
    sessions: 1,
    engagementMin: 3,
    searchSessions: 0,
    searchNoPlaySessions: 0,
    browseNoPlaySessions: 0,
    crashes: 0,
    crashDays: 0,
    errorScreenSessions: 0,
    noInternetSessions: 0,
    accountVisits: 0,
    logoutClicks: 0,
    myListAdds: 0,
    myListRemoves: 0,
    platforms: ['android'],
  });

  function atRiskEngine() {
    const engine = new FakeEngine();
    for (let i = 0; i < 3000; i++) {
      engine.assessments.push(assessment('111', `A${String(i).padStart(6, '0')}`));
    }
    for (let i = 0; i < 1500; i++) {
      engine.assessments.push(assessment('222', `B${String(i).padStart(6, '0')}`));
    }
    // Not at risk, a duplicate and a key the backend would refuse: none is sent.
    engine.assessments.push(assessment('111', 'C000001', false));
    engine.assessments.push(assessment('111', 'A000000'));
    engine.assessments.push(assessment('222', 'bad-key'));
    return engine;
  }

  it('asks for the at-risk accounts in batches by provider, merges them and evaluates again', async () => {
    fetchKeepBehavior.mockImplementation((request: { accountsByPid: Record<string, string[]> }) => {
      const accounts = Object.entries(request.accountsByPid).flatMap(([pid, list]) => list.map((a) => [pid, a]));
      const last = fetchKeepBehavior.mock.calls.length === 3;
      return Promise.resolve({
        status: last ? 'partial' : 'on',
        window: { from: '2026-10-08', to: '2026-10-09', days: 2 },
        requested: accounts.length,
        matched: 1,
        message: last ? 'one day is incomplete' : undefined,
        rows: [onRows(accounts[0][0], accounts[0][1])],
      });
    });
    const engine = atRiskEngine();
    const progress: KeepProgress[] = [];
    const snapshot = await scan(engine, { useBehavior: true, onProgress: (p) => progress.push(p) });

    expect(fetchKeepBehavior).toHaveBeenCalledTimes(3);
    const requests = fetchKeepBehavior.mock.calls.map((call) => call[0]);
    expect(requests.map((r) => Object.values(r.accountsByPid).flat().length)).toEqual([2000, 2000, 500]);
    expect(requests[0]).toMatchObject({ asOf: '2026-10-09', recentDays: 2 });
    expect(Object.keys(requests[0].accountsByPid)).toEqual(['111']);
    expect(Object.keys(requests[1].accountsByPid)).toEqual(['111', '222']);
    expect(requests[1].accountsByPid['111']).toHaveLength(1000);
    const sent = requests.flatMap((r) => Object.values(r.accountsByPid).flat());
    expect(new Set(sent).size).toBe(4500);
    expect(sent).not.toContain('C000001');
    expect(sent).not.toContain('bad-key');

    const merged = engine.behaviorLog[engine.behaviorLog.length - 1];
    expect(engine.behaviorLog[0]).toBeNull();
    expect(merged).toMatchObject({
      status: 'partial',
      message: 'one day is incomplete',
      requested: 4500,
      matched: 3,
      window: { from: '2026-10-08', to: '2026-10-09', days: 2 },
    });
    expect(merged?.rows.map((r) => r.account)).toEqual(['A000000', 'A002000', 'B001000']);
    expect(engine.evaluated).toEqual([D, D]);
    expect(snapshot.quality.behavior?.status).toBe('partial');
    expect(progress.filter((p) => p.phase === 'behavior').pop()).toMatchObject({ done: 3, total: 3 });
  });

  it('turns a failed request into a warning, never a failed scan', async () => {
    fetchKeepBehavior.mockRejectedValue(new Error('Network error'));
    const engine = atRiskEngine();
    const warnings: string[] = [];
    const snapshot = await scan(engine, { useBehavior: true, onWarning: (w) => warnings.push(w) });

    expect(snapshot.asOf).toBe(D);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Network error');
    expect(fetchKeepBehavior).toHaveBeenCalledTimes(1);
    expect(engine.behaviorLog[engine.behaviorLog.length - 1]).toMatchObject({ status: 'error', rows: [] });
    expect(engine.evaluated).toEqual([D, D]);
  });

  it('passes an off or pending answer to the engine so the page can say why, without more batches', async () => {
    fetchKeepBehavior.mockResolvedValue({ status: 'off', rows: [] });
    const engine = atRiskEngine();
    const warnings: string[] = [];
    await scan(engine, { useBehavior: true, onWarning: (w) => warnings.push(w) });

    expect(fetchKeepBehavior).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([]);
    expect(engine.behaviorLog[engine.behaviorLog.length - 1]).toMatchObject({ status: 'off', rows: [] });
  });

  it('does not ask when switched off or when nobody is at risk', async () => {
    await scan(atRiskEngine(), { useBehavior: false });
    const quiet = new FakeEngine();
    quiet.assessments.push(assessment('111', 'C000001', false));
    await scan(quiet, { useBehavior: true });
    expect(fetchKeepBehavior).not.toHaveBeenCalled();
    expect(quiet.behaviorLog).toEqual([null]);
    expect(quiet.evaluated).toEqual([D]);
  });

  it('stops on abort during the evidence requests', async () => {
    const controller = new AbortController();
    fetchKeepBehavior.mockImplementation(() => {
      controller.abort();
      return new Promise(() => undefined);
    });
    const engine = atRiskEngine();
    await expect(scan(engine, { useBehavior: true, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(engine.evaluated).toEqual([D]);
  });

  it('caps the recent window at what the backend serves', async () => {
    fetchKeepBehavior.mockResolvedValue({ status: 'on', rows: [] });
    const snapshot = snapshotOf(D, [assessment('111', 'A000001')], null);
    const result = await fetchBehaviorFor(snapshot, 40, new AbortController().signal);
    expect(fetchKeepBehavior.mock.calls[0][0]).toMatchObject({ recentDays: 28, accountsByPid: { '111': ['A000001'] } });
    expect(result).toMatchObject({ status: 'on', requested: 1, matched: 0, rows: [] });
  });

  it('asks for the recent window in whole days, as the engine counts it', async () => {
    fetchKeepBehavior.mockResolvedValue({ status: 'on', rows: [] });
    const snapshot = snapshotOf(D, [assessment('111', 'A000001')], null);
    await fetchBehaviorFor(snapshot, 7.5, new AbortController().signal);
    expect(fetchKeepBehavior.mock.calls[0][0]).toMatchObject({ recentDays: 7 });
  });

  it("adds up the backend's own counts: accounts of providers without GA4 are not linked, not unmatched", async () => {
    // 3000 accounts on 111 (bound to GA4) and 1500 on 222 (not bound).
    fetchKeepBehavior.mockImplementation((request: { accountsByPid: Record<string, string[]> }) => {
      const bound = request.accountsByPid['111']?.length ?? 0;
      const other = request.accountsByPid['222']?.length ?? 0;
      return Promise.resolve({
        status: 'on',
        requested: bound,
        matched: Math.floor(bound / 2),
        notLinked: other,
        rows: [],
      });
    });
    const engine = atRiskEngine();
    await scan(engine, { useBehavior: true });
    expect(fetchKeepBehavior).toHaveBeenCalledTimes(3);
    expect(engine.behaviorLog[engine.behaviorLog.length - 1]).toMatchObject({
      status: 'on',
      requested: 3000,
      matched: 1500,
      notLinked: 1500,
    });

    // An answer without counts: the batch size stands in, nothing is called "not linked".
    fetchKeepBehavior.mockReset();
    fetchKeepBehavior.mockResolvedValue({ status: 'on', rows: [] });
    const result = await fetchBehaviorFor(
      snapshotOf(D, [assessment('111', 'A000001'), assessment('222', 'B000001')], null),
      7,
      new AbortController().signal
    );
    expect(result).toMatchObject({ requested: 2, matched: 0 });
    expect(result?.notLinked).toBeUndefined();
  });

  it('goes on after a batch that holds only providers without GA4, and is off when no batch had one', async () => {
    // The backend answers a batch of unbound providers only with an empty "on".
    const answer = (request: { accountsByPid: Record<string, string[]> }) => {
      const bound = request.accountsByPid['111']?.length ?? 0;
      const other = request.accountsByPid['222']?.length ?? 0;
      return Promise.resolve({ status: 'on', requested: bound, matched: bound, notLinked: other, rows: [] });
    };
    fetchKeepBehavior.mockImplementation(answer);
    const accounts = [
      ...Array.from({ length: BEHAVIOR_BATCH }, (_, i) => assessment('222', `B${String(i).padStart(6, '0')}`)),
      assessment('111', 'A000001'),
    ];
    const both = await fetchBehaviorFor(snapshotOf(D, accounts, null), 7, new AbortController().signal);
    expect(fetchKeepBehavior).toHaveBeenCalledTimes(2);
    expect(both).toMatchObject({ status: 'on', requested: 1, matched: 1, notLinked: BEHAVIOR_BATCH });

    fetchKeepBehavior.mockClear();
    const none = await fetchBehaviorFor(
      snapshotOf(D, [assessment('222', 'B000001')], null),
      7,
      new AbortController().signal
    );
    expect(none).toMatchObject({ status: 'off', requested: 0, notLinked: 1 });
  });
});

describe('estimateScan', () => {
  const plan = planScan(DEFAULT_KEEP_RULES, 'scan', D, undefined, NOW);
  const signal = new AbortController().signal;

  it('multiplies the accounts of the latest day by the days of the plan', async () => {
    queryRows.mockResolvedValue([
      { pid: '222', accounts: 60000 },
      { pid: '111', accounts: '100000' },
    ]);
    const estimate = await estimateScan(DS, ['111', '222'], plan, signal);
    expect(queryRows.mock.calls[0][1]).toBe(`estimate ${D} 111,222`);
    expect(estimate).toEqual({
      perPid: [
        { pid: '111', accounts: 100000 },
        { pid: '222', accounts: 60000 },
      ],
      accountsPerDay: 160000,
      accountDays: 160000 * 40,
      tooLarge: true,
    });

    queryRows.mockResolvedValue([{ pid: '111', accounts: 1000 }]);
    expect(await estimateScan(DS, ['111'], plan, signal)).toMatchObject({ accountDays: 40000, tooLarge: false });
  });

  it('is best effort: no estimate when the query fails or finds nothing', async () => {
    queryRows.mockRejectedValue(new Error('Code: 60. Table does not exist'));
    expect(await estimateScan(DS, null, plan, signal)).toBeNull();
    queryRows.mockResolvedValue([]);
    expect(await estimateScan(DS, null, plan, signal)).toBeNull();
  });

  it('needs no query for an empty scope', async () => {
    expect(await estimateScan(DS, [], plan, signal)).toEqual({
      perPid: [],
      accountsPerDay: 0,
      accountDays: 0,
      tooLarge: false,
    });
    expect(queryRows).not.toHaveBeenCalled();
  });
});
