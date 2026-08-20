// Analytix: browser-side leg of the assistant's query bridge.
//
// The ai-grafana-helper backend has no ClickHouse credentials. While the agent
// writes SQL it emits `query` SSE events; this module executes each statement
// through the user's own Grafana ClickHouse datasource — with the user's
// permissions — and returns rows in the shape the backend expects
// (an array of plain objects, like ClickHouse's JSON format).

import { lastValueFrom } from 'rxjs';

import { CoreApp, DataFrame, DataQuery, DataQueryRequest, DataSourceRef, FieldType, getDefaultTimeRange } from '@grafana/data';
import { DataSourceWithBackend, getDataSourceSrv } from '@grafana/runtime';

/** A raw SQL query understood by both the official and community ClickHouse plugins. */
interface SqlQuery extends DataQuery {
  rawSql: string;
  query: string;
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
const FORBIDDEN_TABLE_FN_RE =
  /\b(url|urlCluster|file|fileCluster|remote|remoteSecure|s3|s3Cluster|s3Queue|gcs|oss|azureBlobStorage|azureBlobStorageCluster|hdfs|hdfsCluster|deltaLake|iceberg|hudi|mysql|postgresql|jdbc|odbc|mongodb|redis|sqlite|executable|input|cluster|clusterAllReplicas)\s*\(/i;
const SYSTEM_SCHEMA_RE = /\b(system|information_schema)\s*\./i;

/** True when the statement is a single read-only query inside the analytics data. */
export function isSafeBridgeSql(sql: string): boolean {
  const s = sql.trim();
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

/**
 * Execute one read-only SQL statement via the given datasource and convert the
 * first returned frame to rows. Throws with the datasource's error text so the
 * agent can self-correct. `maxRows` truncates client-side — the backend caps
 * its own tool output anyway, no point shipping more.
 */
export async function runRawQuery(datasource: DataSourceRef, sql: string, maxRows: number): Promise<RawQueryResult> {
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
    targets: [{ refId: 'A', datasource, rawSql: sql, query: sql }],
  };

  const result = await Promise.race([
    lastValueFrom(ds.query(request)),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`The datasource did not answer within ${QUERY_TIMEOUT_MS / 1000}s.`)), QUERY_TIMEOUT_MS)
    ),
  ]);

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
