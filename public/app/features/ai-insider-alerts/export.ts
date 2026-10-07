// Analytix: AI Insider Alerts - exports for offline analysis. Two files:
//   - the run: what the current rules decided (incidents, viewers, messages),
//   - the dataset: the raw material to replay other rules against — every
//     minute of every channel that had errors, and every viewer-minute with
//     an error (platform, network, ISP, city, code, stream path).
// Both are gzipped in the browser and saved locally; nothing leaves Grafana.

import { DataSourceRef } from '@grafana/data';
import { runRawQuery } from 'app/features/dashboard-scene/ai-panel/datasourceQuery';

import type { AlertsSnapshot } from './AlertsResults';
import { isTransientError, withRetry } from './retry';
import { ALERTS_MAX_RESULT_CHARS, chunks } from './runner';
import {
  activitySql,
  badMinutesSql,
  channelHealthSql,
  channelMinutesSql,
  ChannelKey,
  providerBucketsSql,
  userErrorsSql,
} from './sql';
import type { AlertRules } from './types';

export const EXPORT_FORMAT_VERSION = 1;

const MAX_ROWS = 200000;
const CHANNELS_BATCH = 50;
/** A channel joins the dataset once two viewers fail on it in one minute. */
const DATASET_MIN_ERR_USERS = 2;

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Gzips text parts when the browser can (CompressionStream); plain text otherwise. */
export async function packText(parts: string[], type: string): Promise<{ blob: Blob; gzipped: boolean }> {
  const plain = new Blob(parts, { type });
  if (typeof CompressionStream === 'undefined') {
    return { blob: plain, gzipped: false };
  }
  const stream = plain.stream().pipeThrough(new CompressionStream('gzip'));
  return { blob: await new Response(stream).blob(), gzipped: true };
}

function day(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 16).replace(':', '');
}

export function exportFileName(kind: 'run' | 'dataset', from: number, to: number, ext: string): string {
  return `ai-insider-alerts-${kind}_${day(from)}_${day(to)}.${ext}`;
}

export interface ExportMeta {
  from: number;
  to: number;
  pids: string[] | null;
  rules: AlertRules;
  mode: string;
}

/** The current run as one JSON document. */
export async function exportRun(snapshot: AlertsSnapshot, meta: ExportMeta) {
  const doc = {
    format: 'ai-insider-alerts-run',
    version: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    ...meta,
    replayedUpTo: snapshot.to,
    summary: snapshot.summary,
    blips: snapshot.blips,
    groups: snapshot.groups,
    incidents: snapshot.incidents.map((i) => ({
      ...i,
      class: snapshot.classOf(i),
      viewers: snapshot.affected(i.id),
    })),
    decisions: snapshot.decisions,
    customerSide: snapshot.customer,
    deadChannels: snapshot.dead,
    channelReport: snapshot.channels,
    providerIncidents: snapshot.providers.map((p) => ({ ...p, viewers: snapshot.providerAffected(p.id) })),
    serviceIncidents: snapshot.activity,
  };
  const { blob, gzipped } = await packText([JSON.stringify(doc)], 'application/json');
  downloadBlob(blob, exportFileName('run', meta.from, meta.to, gzipped ? 'json.gz' : 'json'));
}

export interface DatasetOptions {
  datasource: DataSourceRef;
  pids: string[] | null;
  from: number;
  to: number;
  rules: AlertRules;
  signal: AbortSignal;
  onChunk: (clock: number, rows: number) => void;
  /** Pauses between retries of a transient failure (tests pass zeros). */
  retryDelaysMs?: number[];
}

type Row = Record<string, unknown>;

class TruncatedResult extends Error {
  constructor() {
    super('Result was cut by the size budget.');
  }
}

/**
 * Walks [from, to) hour by hour and collects the tuning dataset as NDJSON.
 * The first line is the `meta` object; each record type is announced once
 * by a `{"t":"columns","type":…,"columns":[…]}` line, and its rows follow as
 * compact arrays `["<type>", v1, v2, …]` (a week of two big operators is
 * ~1M rows, so keys are not repeated per row). Types: `min` (channel-minute),
 * `err` (viewer-minute with an error), `health` (per channel and hour),
 * `prov` (per provider and 15 minutes: viewers, viewers with errors), `act`
 * (per provider and 5 minutes: app starts, playback starts, events). A
 * channel keeps its minutes for one more hour after it last qualified, so
 * recoveries that cross an hour boundary stay visible. The last line is
 * `{"t":"end","complete":…,"upTo":…}`: an export that hit a persistent
 * failure still returns every complete hour before it.
 */
export interface DatasetResult {
  blob: Blob;
  gzipped: boolean;
  /** False when a query kept failing: the file holds everything before `upTo`. */
  complete: boolean;
  /** End of the last hour written to the file. */
  upTo: number;
  error?: string;
}

export async function runDatasetExport(opts: DatasetOptions): Promise<DatasetResult> {
  const delays = opts.retryDelaysMs;
  const run = (sql: string): Promise<Row[]> =>
    withRetry(
      async () => {
        const result = await runRawQuery(opts.datasource, sql, MAX_ROWS, opts.signal, {
          maxResultChars: ALERTS_MAX_RESULT_CHARS,
        });
        if (result.truncated) {
          throw new TruncatedResult();
        }
        return result.data;
      },
      opts.signal,
      delays
    );
  /**
   * A window that is cut (too large) or keeps failing (the proxy times out on
   * a busy hour) is re-read as two halves, down to `step` seconds, so one
   * heavy hour neither loses rows nor stops the export. `step` keeps the
   * halves aligned to the query's own grouping (15 minutes for providers).
   */
  const runSplit = async (
    make: (from: number, to: number) => string,
    from: number,
    to: number,
    step = 60
  ): Promise<Row[]> => {
    try {
      return await run(make(from, to));
    } catch (e) {
      const truncated = e instanceof TruncatedResult;
      // A cut result is split down to single steps; a failing proxy only down
      // to 15 minutes, so a hour that keeps failing gives up in minutes.
      const floor = truncated ? step : Math.max(step, 900);
      if (!(truncated || isTransientError(e)) || opts.signal.aborted || to - from <= floor) {
        throw e instanceof TruncatedResult ? new Error('A single-step result is still too large to export.') : e;
      }
      const mid = from + Math.max(step, Math.floor((to - from) / (2 * step)) * step);
      return [...(await runSplit(make, from, mid, step)), ...(await runSplit(make, mid, to, step))];
    }
  };
  const columns = new Map<string, string[]>();
  const emit = (type: string, row: Row) => {
    let cols = columns.get(type);
    if (!cols) {
      cols = Object.keys(row);
      columns.set(type, cols);
      parts.push(JSON.stringify({ t: 'columns', type, columns: cols }) + '\n');
    }
    parts.push(JSON.stringify([type, ...cols.map((c) => row[c] ?? null)]) + '\n');
  };
  const parts: string[] = [
    JSON.stringify({
      t: 'meta',
      format: 'ai-insider-alerts-dataset',
      version: EXPORT_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      from: opts.from,
      to: opts.to,
      pids: opts.pids,
      rules: opts.rules,
    }) + '\n',
  ];
  const discovery: AlertRules = { ...opts.rules, minUsers: 1, minErrUsers: DATASET_MIN_ERR_USERS, minErrShare: 0 };
  let previous = new Map<string, ChannelKey>();
  let rows = 0;
  let upTo = opts.from;
  let error: string | undefined;

  for (const [from, to] of chunks(opts.from, opts.to, 3600)) {
    if (opts.signal.aborted) {
      throw new Error('Export cancelled.');
    }
    try {
      // One query at a time: the export is offline work, and four heavy
      // all-provider queries at once on a peak hour is what times the proxy out.
      const bad = await runSplit((f, t) => badMinutesSql(f, t, opts.pids, discovery), from, to);
      const errors = await runSplit((f, t) => userErrorsSql(f, t, opts.pids), from, to);
      const health = await run(channelHealthSql(from, to, opts.pids));
      const providers = await runSplit((f, t) => providerBucketsSql(f, t, opts.pids), from, to, 900);
      const activity = await runSplit((f, t) => activitySql(f, t, opts.pids), from, to, 300);
      const current = new Map<string, ChannelKey>();
      for (const r of bad) {
        const key = { pid: String(r.pid ?? ''), cid: String(r.cid ?? '') };
        if (/^[A-Za-z0-9_-]+$/.test(key.pid) && /^[A-Za-z0-9_-]+$/.test(key.cid)) {
          current.set(`${key.pid}|${key.cid}`, key);
        }
      }
      const followed = [...new Map([...previous, ...current]).values()];
      const minutes: Row[] = [];
      for (let i = 0; i < followed.length; i += CHANNELS_BATCH) {
        const batch = followed.slice(i, i + CHANNELS_BATCH);
        minutes.push(...(await runSplit((f, t) => channelMinutesSql(f, t, opts.pids, batch), from, to)));
      }
      // The hour is written only once every query of it succeeded.
      minutes.forEach((r) => emit('min', r));
      errors.forEach((r) => emit('err', r));
      health.forEach((r) => emit('health', { chunk_from: from, chunk_to: to, ...r }));
      providers.forEach((r) => emit('prov', r));
      activity.forEach((r) => emit('act', r));
      rows += minutes.length + errors.length + health.length + providers.length + activity.length;
      previous = current;
      upTo = to;
      opts.onChunk(to, rows);
    } catch (e) {
      if (opts.signal.aborted) {
        throw new Error('Export cancelled.');
      }
      error = e instanceof Error ? e.message : String(e);
      break;
    }
  }
  parts.push(JSON.stringify({ t: 'end', complete: error === undefined, upTo, error: error ?? null }) + '\n');
  const packed = await packText(parts, 'application/x-ndjson');
  return { ...packed, complete: error === undefined, upTo, error };
}
