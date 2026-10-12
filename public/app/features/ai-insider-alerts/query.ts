// Analytix: AI Insider Alerts - one place where both sections run SQL through
// the user's own Grafana ClickHouse datasource. Transient failures (the proxy
// in front of ClickHouse answering 502, a dropped connection) are retried; a
// result cut by the client-side limits is an error, never a silent cut.

import { DataSourceRef } from '@grafana/data';
import { runRawFrame, runRawQuery } from 'app/features/dashboard-scene/ai-panel/datasourceQuery';

import type { FrameLike } from './keep/types';
import { isTransientError, RETRY_DELAYS_MS, withRetry } from './retry';

export interface QueryOptions {
  signal?: AbortSignal;
  /** Client-side wait for the datasource (default: the bridge's 55 s). */
  timeoutMs?: number;
  /** Waits between retries (default RETRY_DELAYS_MS). */
  retryDelaysMs?: number[];
  /** Which errors are retried (default isTransientError). */
  isRetryable?: (error: unknown) => boolean;
  /** queryRows only: row cap (a cut result throws). */
  maxRows?: number;
  /** queryRows only: result-size budget in characters. */
  maxResultChars?: number;
}

/** Row cap of queryRows when the caller sets none. */
export const DEFAULT_MAX_ROWS = 50_000;
/**
 * Result-size budget of queryRows when the caller sets none. The rows stay in
 * the browser, so the chat bridge's 3M-character budget does not apply.
 */
export const DEFAULT_MAX_RESULT_CHARS = 64_000_000;

/** A result that did not fit `maxRows` / `maxResultChars` (rows were dropped). */
export class TruncatedResultError extends Error {
  constructor(readonly maxRows: number) {
    super(`The result was cut at ${maxRows} rows or by the result-size budget.`);
    this.name = 'TruncatedResultError';
  }
}

// The bridge's own wait ("did not answer within") and ClickHouse's
// max_execution_time (code 159, TIMEOUT_EXCEEDED, "Timeout exceeded: elapsed…").
const TIMEOUT_RE = /did not answer within|\bTIMEOUT_EXCEEDED\b|timeout exceeded|\bcode:? 159\b/i;

/** True for a query that ran out of time (client or ClickHouse), as opposed to a failure. */
export function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return TIMEOUT_RE.test(message);
}

/**
 * Transient failures except running out of time: repeating a statement that
 * timed out costs another full scan and most likely times out again — split
 * the work instead.
 */
export function isTransientNotTimeout(error: unknown): boolean {
  return isTransientError(error) && !isTimeoutError(error);
}

const idle = () => new AbortController().signal;

/** One statement, the first frame as returned (columnar, no per-row objects, no client row cap). */
export async function queryFrame(datasource: DataSourceRef, sql: string, opts: QueryOptions = {}): Promise<FrameLike> {
  const signal = opts.signal ?? idle();
  return withRetry(
    () => runRawFrame(datasource, sql, signal, { timeoutMs: opts.timeoutMs }),
    signal,
    opts.retryDelaysMs ?? RETRY_DELAYS_MS,
    opts.isRetryable ?? isTransientError
  );
}

/** One statement as row objects; a result cut by maxRows / maxResultChars throws. */
export async function queryRows(
  datasource: DataSourceRef,
  sql: string,
  opts: QueryOptions = {}
): Promise<Array<Record<string, unknown>>> {
  const signal = opts.signal ?? idle();
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const result = await withRetry(
    () =>
      runRawQuery(datasource, sql, maxRows, signal, {
        maxResultChars: opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS,
        timeoutMs: opts.timeoutMs,
      }),
    signal,
    opts.retryDelaysMs ?? RETRY_DELAYS_MS,
    opts.isRetryable ?? isTransientError
  );
  // Checked after the retries on purpose: the same statement would be cut again.
  if (result.truncated) {
    throw new TruncatedResultError(maxRows);
  }
  return result.data;
}
