// Analytix: AI Insider Alerts - exports for offline analysis. Two files:
//   - the run: what the current rules decided (incidents, viewers, messages),
//   - the dataset: the raw material to replay other rules against — every
//     minute of every channel that had errors, and every viewer-minute with
//     an error (platform, network, ISP, city, code, stream path).
// Both are gzipped in the browser and saved locally; nothing leaves Grafana.

import { DataSourceRef } from '@grafana/data';
import { runRawQuery } from 'app/features/dashboard-scene/ai-panel/datasourceQuery';

import type { AlertsSnapshot } from './AlertsResults';
import { chunks } from './runner';
import { badMinutesSql, channelHealthSql, channelMinutesSql, ChannelKey, userErrorsSql } from './sql';
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
}

type Row = Record<string, unknown>;

/**
 * Walks [from, to) hour by hour and collects the tuning dataset as NDJSON.
 * The first line is the `meta` object; each record type is announced once
 * by a `{"t":"columns","type":…,"columns":[…]}` line, and its rows follow as
 * compact arrays `["<type>", v1, v2, …]` (a week of two big operators is
 * ~1M rows, so keys are not repeated per row). Types: `min` (channel-minute),
 * `err` (viewer-minute with an error), `health` (per channel and hour). A
 * channel keeps its minutes for one more hour after it last qualified, so
 * recoveries that cross an hour boundary stay visible.
 */
export async function runDatasetExport(opts: DatasetOptions): Promise<{ blob: Blob; gzipped: boolean }> {
  const run = async (sql: string): Promise<Row[]> =>
    (await runRawQuery(opts.datasource, sql, MAX_ROWS, opts.signal)).data;
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

  for (const [from, to] of chunks(opts.from, opts.to, 3600)) {
    if (opts.signal.aborted) {
      throw new Error('Export cancelled.');
    }
    const [bad, errors, health] = await Promise.all([
      run(badMinutesSql(from, to, opts.pids, discovery)),
      run(userErrorsSql(from, to, opts.pids)),
      run(channelHealthSql(from, to, opts.pids)),
    ]);
    const current = new Map<string, ChannelKey>();
    for (const r of bad) {
      const key = { pid: String(r.pid ?? ''), cid: String(r.cid ?? '') };
      if (/^[A-Za-z0-9_-]+$/.test(key.pid) && /^[A-Za-z0-9_-]+$/.test(key.cid)) {
        current.set(`${key.pid}|${key.cid}`, key);
      }
    }
    const followed = [...new Map([...previous, ...current]).values()];
    for (let i = 0; i < followed.length; i += CHANNELS_BATCH) {
      const minutes = await run(channelMinutesSql(from, to, opts.pids, followed.slice(i, i + CHANNELS_BATCH)));
      minutes.forEach((r) => emit('min', r));
      rows += minutes.length;
    }
    errors.forEach((r) => emit('err', r));
    health.forEach((r) => emit('health', { chunk_from: from, chunk_to: to, ...r }));
    rows += errors.length + health.length;
    previous = current;
    opts.onChunk(to, rows);
  }
  return packText(parts, 'application/x-ndjson');
}
