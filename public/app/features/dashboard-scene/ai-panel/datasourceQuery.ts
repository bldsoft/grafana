// Analytix: browser-side leg of the assistant's query bridge.
//
// The ai-grafana-helper backend has no ClickHouse credentials. While the agent
// writes SQL it emits `query` SSE events; this module executes each statement
// through the user's own Grafana ClickHouse datasource — with the user's
// permissions — and returns rows in the shape the backend expects
// (an array of plain objects, like ClickHouse's JSON format).

import { lastValueFrom, map, merge, Observable, takeUntil, timer } from 'rxjs';

import { CoreApp, DataFrame, DataQuery, DataQueryRequest, DataSourceRef, FieldType, getDefaultTimeRange } from '@grafana/data';
import { DataSourceWithBackend, getDataSourceSrv } from '@grafana/runtime';

/** A raw SQL query understood by both the official and community ClickHouse plugins. */
export interface SqlQuery extends DataQuery {
  rawSql: string;
  query: string;
  /** Official plugin only: the sqlds result format (see rawSqlQuery). */
  format?: number;
}

/** Plugin id of the official ClickHouse datasource (grafana/clickhouse-datasource). */
export const OFFICIAL_CLICKHOUSE_PLUGIN_ID = 'grafana-clickhouse-datasource';
// sqlds `FormatOptionTable`: hand the rows back as one table frame. The
// default (`FormatOptionTimeSeries`, 0 — what a query without `format` gets)
// runs LongToWide on any frame that has a time column, a string column and a
// number column: it rejects rows that are not sorted by time ("long series
// must be sorted ascending by time") and NULL times ("input has null time
// values"), and it pivots exploration results into wide `value {label=...}`
// columns the agent cannot read. Two generated panels failed exactly that way
// on 2026-09-07. The chat reshapes long results client-side instead
// (buildPanel.ts), where sorting and NULL times are handled.
export const CLICKHOUSE_FORMAT_TABLE = 1;

/**
 * The query object for one raw SQL statement against the given datasource.
 * `rawSql`/`query` cover the official and the community plugin; `format` is
 * set only for the official plugin — the community plugin types that field
 * as a string ('time_series' | 'table') and is left on its own default.
 */
export function rawSqlQuery(datasource: DataSourceRef, sql: string, refId = 'A'): SqlQuery {
  const query: SqlQuery = { refId, rawSql: sql, query: sql };
  if (datasource.type === OFFICIAL_CLICKHOUSE_PLUGIN_ID) {
    query.format = CLICKHOUSE_FORMAT_TABLE;
  }
  return query;
}

export interface RawQueryResult {
  data: Array<Record<string, unknown>>;
  rows: number;
  meta: Array<{ name: string; type: string }>;
}

// Client-side mirror of the backend's SQL gate (services/clickhouse.js).
// Defense in depth: the backend never sends anything else, but if the
// assistant URL override (localStorage) ever points at a hostile host, this
// keeps it from driving arbitrary reads through the user's datasource.
const ALLOWED_RE = /^\s*(select|show|describe|desc|exists|with|explain)\b/i;
const FORBIDDEN_RE = /\b(insert|alter|drop|truncate|create|rename|attach|detach|optimize|grant|revoke|set\s+role|kill)\b/i;
// The object-storage families (s3 and its aliases cosn/gcs/oss, plus azure,
// hdfs, iceberg, deltaLake, hudi) take a `\w*` suffix so ClickHouse variants the
// list did not name (s3Cluster, icebergS3, deltaLakeAzure, hdfsCluster, ...)
// cannot slip past an enumerated blocklist. Names that would collide with
// legitimate scalar functions (url vs URLHierarchy, file vs filesystemAvailable)
// stay exact-match. Mirror of the backend gate (services/clickhouse.js).
const FORBIDDEN_TABLE_FN_RE =
  /\b(url|urlCluster|file|fileCluster|remote|remoteSecure|s3\w*|cosn\w*|gcs\w*|oss\w*|azureBlobStorage\w*|hdfs\w*|deltaLake\w*|iceberg\w*|hudi\w*|mysql|postgresql|jdbc|odbc|mongodb|redis|sqlite|executable|input|cluster|clusterAllReplicas)\s*\(/i;
const SYSTEM_SCHEMA_RE = /\b(system|information_schema)\s*\./i;

// Strip SQL comments for DETECTION only (the executed SQL is untouched).
// ClickHouse treats `/* */`, `-- ` and `#` as token separators, so
// `url/**/(...)` or `system/**/.processes` parse as real calls server-side but
// would slip past a regex that stitches the name to `(`/`.` via `\s*`.
// Removing comments before the gate closes that bypass and can only reveal
// hidden tokens, never hide one. Mirror of the backend gate.
function stripSqlComments(sql: string): string {
  return String(sql ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ');
}

/** True when the statement is a single read-only query inside the analytics data. */
export function isSafeBridgeSql(sql: string): boolean {
  const s = stripSqlComments(sql).trim();
  return (
    ALLOWED_RE.test(s) &&
    !FORBIDDEN_RE.test(s) &&
    !FORBIDDEN_TABLE_FN_RE.test(s) &&
    !SYSTEM_SCHEMA_RE.test(s) &&
    !s.includes(';')
  );
}

// A hung datasource must not hold the promise forever. Slightly below the
// backend's 60s bridge timeout so the error we ship back wins the race.
const QUERY_TIMEOUT_MS = 55000;
// Keep the result body far below the backend's 5MB cap: long string cells are
// truncated, and rows stop accumulating once the budget is spent.
const MAX_CELL_CHARS = 4096;
const MAX_RESULT_CHARS = 3_000_000;

/** Emits once when the signal aborts; used to cancel the datasource request. */
function abortSignal$(signal: AbortSignal): Observable<unknown> {
  return new Observable((subscriber) => {
    const emit = () => {
      subscriber.next(true);
      subscriber.complete();
    };
    if (signal.aborted) {
      emit();
      return undefined;
    }
    signal.addEventListener('abort', emit);
    return () => signal.removeEventListener('abort', emit);
  });
}

/**
 * Execute one read-only SQL statement via the given datasource and convert the
 * first returned frame to rows. Throws with the datasource's error text so the
 * agent can self-correct. `maxRows` truncates client-side — the backend caps
 * its own tool output anyway, no point shipping more. An aborted `signal`
 * (Stop button, chat closed) unsubscribes the datasource request, which
 * cancels the underlying HTTP call instead of letting it run to completion.
 */
export async function runRawQuery(
  datasource: DataSourceRef,
  sql: string,
  maxRows: number,
  signal?: AbortSignal
): Promise<RawQueryResult> {
  if (!isSafeBridgeSql(sql)) {
    throw new Error('Rejected by the client-side gate: only single-statement read-only queries are allowed.');
  }

  const ds = await getDataSourceSrv().get(datasource);

  if (!(ds instanceof DataSourceWithBackend)) {
    throw new Error('The selected datasource does not support backend queries.');
  }

  const request: DataQueryRequest<SqlQuery> = {
    // A unique id per call: Grafana cancels an in-flight request that reuses a
    // request id, so a time-based id could cancel a previous bridge query that
    // started in the same millisecond. randomUUID is collision-free.
    requestId: `ai-panel-bridge-${crypto.randomUUID()}`,
    interval: '1h',
    intervalMs: 3600000,
    range: getDefaultTimeRange(),
    scopedVars: {},
    timezone: 'browser',
    app: CoreApp.Dashboard,
    startTime: 0,
    targets: [{ ...rawSqlQuery(datasource, sql), datasource }],
  };

  // Stop the datasource request on the user's abort OR the query timeout, via a
  // single takeUntil notifier — unsubscribing cancels the underlying HTTP call
  // instead of leaving a heavy ClickHouse query running to completion. rxjs
  // tears the timer down when the source settles, so nothing leaks (the old
  // Promise.race + bare setTimeout leaked one timer per query and never
  // cancelled the request on timeout).
  let timedOut = false;
  const stop$ = merge(
    ...(signal ? [abortSignal$(signal)] : []),
    timer(QUERY_TIMEOUT_MS).pipe(
      map(() => {
        timedOut = true;
        return true;
      })
    )
  );
  const timeoutError = () => new Error(`The datasource did not answer within ${QUERY_TIMEOUT_MS / 1000}s.`);

  let result;
  try {
    result = await lastValueFrom(ds.query(request).pipe(takeUntil(stop$)));
  } catch (e) {
    // takeUntil completes the stream with no value on abort/timeout; if nothing
    // was emitted yet lastValueFrom rejects with EmptyError — name the real cause.
    if (signal?.aborted) {
      throw new Error('Query cancelled.');
    }
    if (timedOut) {
      throw timeoutError();
    }
    throw e;
  }
  // takeUntil can also complete AFTER a (loading) value was emitted, so
  // lastValueFrom resolves rather than rejects — re-check the real reason.
  if (signal?.aborted) {
    throw new Error('Query cancelled.');
  }
  if (timedOut) {
    throw timeoutError();
  }

  const errorText = result.errors?.map((e) => e.message).filter(Boolean).join('; ') || result.error?.message;
  if (errorText) {
    throw new Error(errorText);
  }

  const frame: DataFrame | undefined = result.data?.[0];
  if (!frame) {
    return { data: [], rows: 0, meta: [] };
  }
  return frameToRows(frame, maxRows);
}

function frameToRows(frame: DataFrame, maxRows: number): RawQueryResult {
  const limit = Math.min(frame.length, Math.max(1, maxRows));
  const data: Array<Record<string, unknown>> = [];
  let budget = MAX_RESULT_CHARS;

  for (let i = 0; i < limit && budget > 0; i++) {
    const row: Record<string, unknown> = {};
    for (const field of frame.fields) {
      let value: unknown = field.values[i];
      // Time fields arrive as epoch millis; the agent reasons in SQL datetimes.
      if (field.type === FieldType.time && typeof value === 'number') {
        value = new Date(value).toISOString();
      }
      // One oversized cell must not blow the backend's result-body cap.
      if (typeof value === 'string' && value.length > MAX_CELL_CHARS) {
        value = `${value.slice(0, MAX_CELL_CHARS)}…[truncated]`;
      }
      row[field.name] = value;
      budget -= typeof value === 'string' ? value.length + 16 : 32;
    }
    data.push(row);
  }

  return {
    data,
    rows: data.length,
    meta: frame.fields.map((f) => ({ name: f.name, type: f.type })),
  };
}
