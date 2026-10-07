// Analytix: AI Insider Alerts - drives the engine through time. A replay walks
// a past window chunk by chunk exactly as a live detector would have seen it
// (the engine only ever learns about minute T after processing T); the live
// mode is the same loop on the tail of the stream. All SQL runs through the
// user's own Grafana ClickHouse datasource, like the AI Insider chat.

import { DataSourceRef } from '@grafana/data';
import { runRawQuery } from 'app/features/dashboard-scene/ai-panel/datasourceQuery';

import { AlertEngine } from './engine';
import { withRetry } from './retry';
import {
  ACTIVITY_BUCKET_SEC,
  activitySql,
  affectedUsersSql,
  badMinutesSql,
  channelHealthSql,
  channelMinutesSql,
  ChannelKey,
  customerSideSql,
  errorVolumeSql,
  IncidentWindow,
  PROVIDER_BUCKET_SEC,
  providerBucketsSql,
  providerNamesSql,
  providerUsersSql,
} from './sql';
import type {
  ActivityBucketRow,
  AffectedUserRow,
  BadMinuteRow,
  ChannelHealthRow,
  CustomerSideRow,
  ErrorVolumeRow,
  ProviderBucketRow,
} from './types';

const MAX_ROWS = 50000;
/** Incidents per viewer query: each adds one branch to a multiIf. */
const USERS_BATCH = 20;
/** Channels per minutes query (one tuple each in an IN list). */
const CHANNELS_BATCH = 50;
/** Live mode stays this far behind the wall clock so late events can land. */
export const LIVE_LAG_SEC = 120;
/** Live mode looks back this far on start, so open incidents are picked up. */
export const LIVE_WARMUP_SEC = 3600;
/** Customer-side checks in live mode cover this trailing window. */
const LIVE_CUSTOMER_WINDOW_SEC = 15 * 60;

type Row = Record<string, unknown>;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (v == null ? '' : String(v));

export function toBadMinute(r: Row): BadMinuteRow {
  return {
    minute: num(r.minute_ts),
    pid: str(r.pid),
    provider: '',
    cid: str(r.cid),
    title: str(r.channel_title),
    users: num(r.users),
    errUsers: num(r.err_users),
    errEvents: num(r.err_events),
    srvErrUsers: num(r.srv_err_users),
    topPath: str(r.top_path),
    topHost: str(r.top_host),
    topPlatform: str(r.top_platform),
    topCode: str(r.top_code),
  };
}

export function toAffectedUser(r: Row, incidentId: string): AffectedUserRow {
  return {
    incidentId,
    userId: str(r.user_id),
    platform: str(r.platform_any),
    network: str(r.network_any),
    isp: str(r.isp_any),
    city: str(r.city_any),
    firstErr: num(r.first_err),
    lastErr: num(r.last_err),
    errEvents: num(r.err_events),
    topCode: str(r.top_code),
    watchedBeforeSec: num(r.watched_before),
  };
}

export function toProviderBucket(r: Row): ProviderBucketRow {
  return {
    bucket: num(r.bucket_ts),
    pid: str(r.pid),
    users: num(r.users),
    errUsers: num(r.err_users),
    srvErrUsers: num(r.srv_err_users),
    errEvents: num(r.err_events),
    topCode: str(r.top_code),
    topPlatform: str(r.top_platform),
  };
}

export function toActivityBucket(r: Row): ActivityBucketRow {
  return {
    bucket: num(r.bucket_ts),
    pid: str(r.pid),
    users: num(r.users),
    sessions: num(r.sessions),
    plays: num(r.plays),
    errEvents: num(r.err_events),
    events: num(r.events),
  };
}

export function toCustomerSide(r: Row): CustomerSideRow {
  return {
    pid: str(r.pid),
    provider: '',
    userId: str(r.user_id),
    platform: str(r.platform_any),
    network: str(r.network_any),
    isp: str(r.isp_any),
    city: str(r.city_any),
    channels: num(r.channels),
    minutes: num(r.minutes),
    errEvents: num(r.err_events),
    firstMinute: num(r.first_minute),
    lastMinute: num(r.last_minute),
    topCode: str(r.top_code),
  };
}

export function toChannelHealth(r: Row): ChannelHealthRow {
  return {
    pid: str(r.pid),
    provider: '',
    cid: str(r.cid),
    title: str(r.channel_title),
    srvErrUsers: num(r.srv_err_users),
    okUsers: num(r.ok_users),
    triedUsers: num(r.tried_users),
  };
}

export function toErrorVolume(r: Row | undefined): ErrorVolumeRow {
  return {
    errEvents: num(r?.err_events),
    errUsers: num(r?.err_users),
    userErrMinutes: num(r?.user_err_minutes),
  };
}

export interface RunOptions {
  datasource: DataSourceRef;
  /** `null` = every provider the datasource can read; `[]` = none. */
  pids: string[] | null;
  engine: AlertEngine;
  signal: AbortSignal;
  /** Called after every processed chunk with the new clock (epoch seconds). */
  onChunk: (clock: number) => void;
  /** Non-fatal problems (e.g. provider names unavailable). */
  onWarning?: (message: string) => void;
}

/** Splits [from, to) into chunks of `step` seconds aligned to whole minutes. */
export function chunks(from: number, to: number, step: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const size = Math.max(60, Math.floor(step / 60) * 60);
  for (let start = Math.floor(from / 60) * 60; start < to; start += size) {
    out.push([start, Math.min(start + size, to)]);
  }
  return out;
}

/**
 * Results stay in the browser, so the bridge's 3M-character budget does not
 * apply; a result that still does not fit is an error, never a silent cut.
 */
export const ALERTS_MAX_RESULT_CHARS = 64_000_000;

async function query(opts: RunOptions, sql: string): Promise<Row[]> {
  const result = await withRetry(
    () => runRawQuery(opts.datasource, sql, MAX_ROWS, opts.signal, { maxResultChars: ALERTS_MAX_RESULT_CHARS }),
    opts.signal
  );
  if (result.truncated) {
    throw new Error(
      `A query returned more than ${MAX_ROWS} rows and was cut. Narrow the providers or use the 15 min step.`
    );
  }
  return result.data;
}

/** Complete buckets of a window plus the same buckets of previous days not read yet. */
interface BucketFetch {
  start: number;
  end: number;
  current: Row[];
  baselines: Array<{ from: number; to: number; rows: Row[] }>;
}

interface ChunkData {
  health: Row[];
  minutes: Row[];
  customer: Row[];
  volume: Row[];
  providers?: BucketFetch;
  activity?: BucketFetch;
  pids: string[];
}

/**
 * Processes one window [from, to) in two phases. Every read comes first and
 * changes nothing, then everything is applied at once: a query that fails
 * leaves the engine exactly at the previous window, so the same window can
 * simply be run again. Viewers of incidents are read afterwards; an incident
 * whose read failed stays pending and is read with the next window.
 */
async function processChunk(opts: RunOptions, from: number, to: number, customerFrom: number | null) {
  const data = await fetchChunk(opts, from, to, customerFrom);
  applyChunk(opts.engine, data, from, to);
  await fetchViewers(opts);
  await resolveProviderNames(opts, data.pids);
}

/**
 * Reads of one window: health (so a dead channel is known before its minutes
 * are classified), every watched minute of the channels worth following —
 * those already in an incident plus those that fail in this window — the
 * provider buckets that became complete, customer-side and volume.
 */
async function fetchChunk(opts: RunOptions, from: number, to: number, customerFrom: number | null): Promise<ChunkData> {
  const { engine, pids } = opts;
  const followed = engine.followedChannels();
  const [health, bad, customer, volume] = await Promise.all([
    query(opts, channelHealthSql(from, to, pids)),
    query(opts, badMinutesSql(from, to, pids, engine.rules)),
    customerFrom === null ? Promise.resolve([]) : query(opts, customerSideSql(customerFrom, to, pids, engine.rules)),
    query(opts, errorVolumeSql(from, to, pids)),
  ]);

  const channels = new Map<string, ChannelKey>();
  for (const c of [...followed, ...bad.map((r) => ({ pid: str(r.pid), cid: str(r.cid) }))]) {
    if (/^[A-Za-z0-9_-]+$/.test(c.pid) && /^[A-Za-z0-9_-]+$/.test(c.cid)) {
      channels.set(`${c.pid}|${c.cid}`, c);
    }
  }
  const keys = [...channels.values()];
  const minutes: Row[] = [];
  for (let i = 0; i < keys.length; i += CHANNELS_BATCH) {
    minutes.push(...(await query(opts, channelMinutesSql(from, to, pids, keys.slice(i, i + CHANNELS_BATCH)))));
  }
  const [providers, activity] = await Promise.all([fetchProviders(opts, from, to), fetchActivity(opts, from, to)]);
  return {
    health,
    minutes,
    customer,
    volume,
    providers,
    activity,
    pids: [...health.map((r) => str(r.pid)), ...bad.map((r) => str(r.pid))],
  };
}

/** Applies one window's reads; no I/O, so it either happens whole or not at all. */
function applyChunk(engine: AlertEngine, data: ChunkData, from: number, to: number) {
  engine.ingestChannelHealth(data.health.map(toChannelHealth), from, to);
  engine.ingestMinutes(data.minutes.map(toBadMinute));
  engine.advance(to);
  if (data.providers) {
    const { start, end, current, baselines } = data.providers;
    baselines.forEach((b) => engine.ingestProviderBaseline(b.rows.map(toProviderBucket), b.from, b.to));
    engine.ingestProviderBuckets(current.map(toProviderBucket), start, end);
    engine.providerWatermark = end;
  }
  if (data.activity) {
    const { start, end, current, baselines } = data.activity;
    baselines.forEach((b) => engine.activity.ingestBaseline(b.rows.map(toActivityBucket), b.from, b.to));
    engine.activity.ingest(current.map(toActivityBucket), start, end);
    engine.activity.watermark = end;
  }
  engine.ingestCustomerSide(data.customer.map(toCustomerSide));
  engine.ingestErrorVolume(toErrorVolume(data.volume[0]));
  engine.processedTo = to;
}

/** Reads the viewers of every incident (channel and provider) that moved and is not read yet. */
async function fetchViewers(opts: RunOptions) {
  const { engine, pids } = opts;
  const windows = engine.pendingIncidentWindows().filter((w) => /^[A-Za-z0-9_-]+$/.test(w.cid));
  for (let i = 0; i < windows.length; i += USERS_BATCH) {
    const batch: IncidentWindow[] = windows.slice(i, i + USERS_BATCH);
    const rows = await query(opts, affectedUsersSql(batch, pids));
    const byInc = new Map<number, AffectedUserRow[]>();
    for (const row of rows) {
      const idx = num(row.inc);
      const list = byInc.get(idx) ?? [];
      list.push(toAffectedUser(row, batch[idx]?.id ?? ''));
      byInc.set(idx, list);
    }
    batch.forEach((w, idx) => engine.setAffectedUsers(w.id, byInc.get(idx) ?? []));
  }

  const provWindows = engine.pendingProviderWindows();
  for (let i = 0; i < provWindows.length; i += USERS_BATCH) {
    const batch = provWindows.slice(i, i + USERS_BATCH);
    const rows = await query(opts, providerUsersSql(batch, pids));
    const byInc = new Map<number, AffectedUserRow[]>();
    for (const row of rows) {
      const idx = num(row.inc);
      const list = byInc.get(idx) ?? [];
      list.push(toAffectedUser(row, batch[idx]?.id ?? ''));
      byInc.set(idx, list);
    }
    batch.forEach((w, idx) => engine.setProviderAffected(w.id, byInc.get(idx) ?? []));
  }
}

const DAY = 86400;

/**
 * Reads the complete buckets of `size` seconds from the watermark up to `to`,
 * plus the same buckets of previous days for the baseline (once — a replay
 * that already went through those days reuses them).
 */
async function fetchBuckets(
  opts: RunOptions,
  from: number,
  to: number,
  size: number,
  watermark: number | undefined,
  covered: (from: number, to: number) => boolean,
  sql: (from: number, to: number, pids: string[] | null) => string
): Promise<BucketFetch | undefined> {
  const start = watermark ?? Math.ceil(from / size) * size;
  const end = Math.floor(to / size) * size;
  if (end <= start) {
    return undefined;
  }
  const days = Math.min(7, Math.max(1, Math.round(opts.engine.rules.providerBaselineDays)));
  const baselineWindows: Array<[number, number]> = [];
  for (let d = 1; d <= days; d++) {
    if (!covered(start - d * DAY, end - d * DAY)) {
      baselineWindows.push([start - d * DAY, end - d * DAY]);
    }
  }
  const [current, ...baselines] = await Promise.all([
    query(opts, sql(start, end, opts.pids)),
    ...baselineWindows.map(([f, t]) => query(opts, sql(f, t, opts.pids))),
  ]);
  return {
    start,
    end,
    current,
    baselines: baselineWindows.map(([f, t], i) => ({ from: f, to: t, rows: baselines[i] })),
  };
}

/** Provider level: 15-minute buckets of viewers with errors. */
function fetchProviders(opts: RunOptions, from: number, to: number) {
  const { engine } = opts;
  return fetchBuckets(
    opts,
    from,
    to,
    PROVIDER_BUCKET_SEC,
    engine.providerWatermark,
    (f, t) => engine.providerCoveredRange(f, t),
    providerBucketsSql
  );
}

/** App level: 5-minute buckets of app starts, playback starts and events. */
function fetchActivity(opts: RunOptions, from: number, to: number) {
  const { activity } = opts.engine;
  return fetchBuckets(
    opts,
    from,
    to,
    ACTIVITY_BUCKET_SEC,
    activity.watermark,
    (f, t) => activity.coveredRange(f, t),
    activitySql
  );
}

const resolvedPids = new WeakMap<AlertEngine, Set<string>>();

async function resolveProviderNames(opts: RunOptions, pids: string[]) {
  const seen = resolvedPids.get(opts.engine) ?? new Set<string>();
  resolvedPids.set(opts.engine, seen);
  const fresh = Array.from(new Set(pids)).filter((p) => p && !seen.has(p));
  if (!fresh.length) {
    return;
  }
  fresh.forEach((p) => seen.add(p));
  try {
    const rows = await query(opts, providerNamesSql(fresh));
    opts.engine.setProviderNames(Object.fromEntries(rows.map((r) => [str(r.pid), str(r.provider)])));
  } catch (e) {
    // Names are cosmetic: ids are shown instead.
    opts.onWarning?.(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Replays [from, to) chunk by chunk, as a live detector would have seen it.
 * An engine that already went part of the way (a replay stopped by a failure)
 * continues from where it stopped, with everything it found so far.
 */
export async function runReplay(opts: RunOptions & { from: number; to: number; step: number }) {
  const resumeAt = Math.max(opts.from, opts.engine.processedTo ?? opts.from);
  for (const [from, to] of chunks(resumeAt, opts.to, opts.step)) {
    if (opts.signal.aborted) {
      return;
    }
    await processChunk(opts, from, to, from);
    opts.onChunk(to);
  }
  // Viewers left pending by a failure right after the last window.
  await fetchViewers(opts);
}

/**
 * Follows the live tail: warms up on the last hour, then every `pollMs`
 * processes the minutes that became final since the previous step. A step
 * that fails (after the query retries) does not stop the watch: it is
 * reported through `onLiveError` and the same minutes are tried again on the
 * next poll, so a datasource outage only delays detection.
 */
export async function runLive(
  opts: RunOptions & {
    pollMs: number;
    now?: () => number;
    onLiveError?: (message: string, processedTo: number) => void;
  }
) {
  const { engine } = opts;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const settled = () => Math.floor((now() - LIVE_LAG_SEC) / 60) * 60;
  const startAt = settled() - LIVE_WARMUP_SEC;
  let lastCustomer = 0;

  while (!opts.signal.aborted) {
    const to = settled();
    const watermark = engine.processedTo ?? startAt;
    if (to > watermark) {
      // Customer-side needs a few minutes of history, so it runs on a
      // trailing window every five minutes rather than on each step.
      const runCustomer = to - lastCustomer >= 300;
      try {
        for (const [from, end] of chunks(watermark, to, 3600)) {
          if (opts.signal.aborted) {
            return;
          }
          const customerFrom = runCustomer && end === to ? Math.max(from, to - LIVE_CUSTOMER_WINDOW_SEC) : null;
          await processChunk(opts, from, end, customerFrom);
          opts.onChunk(end);
        }
        if (runCustomer) {
          lastCustomer = to;
        }
      } catch (e) {
        if (opts.signal.aborted) {
          return;
        }
        opts.onLiveError?.(e instanceof Error ? e.message : String(e), engine.processedTo ?? startAt);
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, opts.pollMs);
      opts.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
  }
}
