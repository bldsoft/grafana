// Analytix: AI Insider Alerts - drives the engine through time. A replay walks
// a past window chunk by chunk exactly as a live detector would have seen it
// (the engine only ever learns about minute T after processing T); the live
// mode is the same loop on the tail of the stream. All SQL runs through the
// user's own Grafana ClickHouse datasource, like the AI Insider chat.

import { DataSourceRef } from '@grafana/data';
import { runRawQuery } from 'app/features/dashboard-scene/ai-panel/datasourceQuery';

import { AlertEngine } from './engine';
import {
  affectedUsersSql,
  badMinutesSql,
  channelHealthSql,
  channelMinutesSql,
  ChannelKey,
  customerSideSql,
  errorVolumeSql,
  IncidentWindow,
  providerNamesSql,
} from './sql';
import type { AffectedUserRow, BadMinuteRow, ChannelHealthRow, CustomerSideRow, ErrorVolumeRow } from './types';

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

async function query(opts: RunOptions, sql: string): Promise<Row[]> {
  const result = await runRawQuery(opts.datasource, sql, MAX_ROWS, opts.signal);
  return result.data;
}

/**
 * Processes one window [from, to): health first (so a dead channel is known
 * before its minutes are classified), then every watched minute of the
 * channels worth following — those already in an incident plus those that
 * fail in this window — then the viewers of every incident that moved, then
 * customer-side and volume.
 */
async function processChunk(opts: RunOptions, from: number, to: number, customerFrom: number | null) {
  const { engine, pids } = opts;
  const followed = engine.followedChannels();
  const [health, bad, customer, volume] = await Promise.all([
    query(opts, channelHealthSql(from, to, pids)),
    query(opts, badMinutesSql(from, to, pids, engine.rules)),
    customerFrom === null ? Promise.resolve([]) : query(opts, customerSideSql(customerFrom, to, pids, engine.rules)),
    query(opts, errorVolumeSql(from, to, pids)),
  ]);

  engine.ingestChannelHealth(health.map(toChannelHealth), from, to);

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
  engine.ingestMinutes(minutes.map(toBadMinute));
  engine.advance(to);

  const windows = engine.takeIncidentWindows().filter((w) => /^[A-Za-z0-9_-]+$/.test(w.cid));
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

  engine.ingestCustomerSide(customer.map(toCustomerSide));
  engine.ingestErrorVolume(toErrorVolume(volume[0]));
  await resolveProviderNames(opts, [...health.map((r) => str(r.pid)), ...bad.map((r) => str(r.pid))]);
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

/** Replays [from, to) chunk by chunk, as a live detector would have seen it. */
export async function runReplay(opts: RunOptions & { from: number; to: number; step: number }) {
  for (const [from, to] of chunks(opts.from, opts.to, opts.step)) {
    if (opts.signal.aborted) {
      return;
    }
    await processChunk(opts, from, to, from);
    opts.onChunk(to);
  }
}

/**
 * Follows the live tail: warms up on the last hour, then every `pollMs`
 * processes the minutes that became final since the previous step.
 */
export async function runLive(opts: RunOptions & { pollMs: number; now?: () => number }) {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const settled = () => Math.floor((now() - LIVE_LAG_SEC) / 60) * 60;
  let watermark = settled() - LIVE_WARMUP_SEC;
  let lastCustomer = 0;

  while (!opts.signal.aborted) {
    const to = settled();
    if (to > watermark) {
      // Customer-side needs a few minutes of history, so it runs on a
      // trailing window every five minutes rather than on each step.
      const runCustomer = to - lastCustomer >= 300;
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
      watermark = to;
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
