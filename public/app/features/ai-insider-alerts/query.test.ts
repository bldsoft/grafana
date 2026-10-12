import { isTimeoutError, isTransientNotTimeout, queryFrame, queryRows, TruncatedResultError } from './query';
import { isTransientError, withRetry } from './retry';

const runRawQuery = jest.fn();
const runRawFrame = jest.fn();

jest.mock('app/features/dashboard-scene/ai-panel/datasourceQuery', () => ({
  runRawQuery: (...args: unknown[]) => runRawQuery(...args),
  runRawFrame: (...args: unknown[]) => runRawFrame(...args),
}));

const DS = { uid: 'ch', type: 'grafana-clickhouse-datasource' };
const FRAME = { length: 1, fields: [{ name: 'pid', type: 'string', values: ['111'] }] };
const CLIENT_TIMEOUT = 'The datasource did not answer within 55s.';
const SERVER_TIMEOUT =
  'Code: 159. DB::Exception: Timeout exceeded: elapsed 45.012 seconds, maximum: 45. (TIMEOUT_EXCEEDED) (version 24.8.4.13 (official build))';

beforeEach(() => {
  runRawQuery.mockReset();
  runRawFrame.mockReset();
});

describe('isTimeoutError', () => {
  it('knows the client wait and the ClickHouse execution limit', () => {
    expect(isTimeoutError(new Error(CLIENT_TIMEOUT))).toBe(true);
    expect(isTimeoutError(new Error(SERVER_TIMEOUT))).toBe(true);
    expect(isTimeoutError('Code: 159. DB::Exception: limit (TIMEOUT_EXCEEDED)')).toBe(true);
  });

  it('is false for failures that are not about time', () => {
    expect(isTimeoutError(new Error('error querying the database: 502 Bad Gateway'))).toBe(false);
    expect(isTimeoutError(new Error('Code: 241. DB::Exception: Memory limit exceeded'))).toBe(false);
    expect(
      isTimeoutError(new Error('Code: 396. DB::Exception: Limit for result exceeded (TOO_MANY_ROWS_OR_BYTES)'))
    ).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
  });

  it('separates timeouts from the other transient failures', () => {
    // The Alerts retry still treats a timeout as transient (unchanged behaviour).
    expect(isTransientError(new Error(CLIENT_TIMEOUT))).toBe(true);
    expect(isTransientNotTimeout(new Error(CLIENT_TIMEOUT))).toBe(false);
    expect(isTransientNotTimeout(new Error(SERVER_TIMEOUT))).toBe(false);
    expect(isTransientNotTimeout(new Error('503 Service Unavailable'))).toBe(true);
    expect(isTransientNotTimeout(new Error('Failed to fetch'))).toBe(true);
  });
});

describe('withRetry', () => {
  it('retries only what the predicate accepts', async () => {
    const signal = new AbortController().signal;
    let calls = 0;
    const failing = () => {
      calls += 1;
      return Promise.reject(new Error(CLIENT_TIMEOUT));
    };
    await expect(withRetry(failing, signal, [0, 0])).rejects.toThrow('did not answer');
    expect(calls).toBe(3);
    calls = 0;
    await expect(withRetry(failing, signal, [0, 0], isTransientNotTimeout)).rejects.toThrow('did not answer');
    expect(calls).toBe(1);
  });
});

describe('queryFrame', () => {
  it('returns the first frame as the datasource gave it, after retrying a 502', async () => {
    runRawFrame.mockRejectedValueOnce(new Error('502 Bad Gateway')).mockResolvedValueOnce(FRAME);
    const signal = new AbortController().signal;
    const frame = await queryFrame(DS, 'SELECT 1', { signal, retryDelaysMs: [0], timeoutMs: 50_000 });
    expect(frame).toBe(FRAME);
    expect(runRawFrame).toHaveBeenCalledTimes(2);
    expect(runRawFrame).toHaveBeenLastCalledWith(DS, 'SELECT 1', signal, { timeoutMs: 50_000 });
  });

  it('does not repeat a timeout when the caller says so', async () => {
    runRawFrame.mockRejectedValue(new Error(SERVER_TIMEOUT));
    const error = await queryFrame(DS, 'SELECT 1', {
      retryDelaysMs: [0, 0],
      isRetryable: isTransientNotTimeout,
    }).catch((e) => e);
    expect(isTimeoutError(error)).toBe(true);
    expect(runRawFrame).toHaveBeenCalledTimes(1);
  });

  it('fails at once on a query error', async () => {
    runRawFrame.mockRejectedValue(new Error('Code: 62. DB::Exception: Syntax error'));
    await expect(queryFrame(DS, 'SELECT 1', { retryDelaysMs: [0] })).rejects.toThrow('Syntax error');
    expect(runRawFrame).toHaveBeenCalledTimes(1);
  });
});

describe('queryRows', () => {
  it('passes the row cap, the size budget and the wait, and returns the rows', async () => {
    runRawQuery.mockResolvedValue({ data: [{ pid: '111' }], rows: 1, meta: [], truncated: false });
    const rows = await queryRows(DS, 'SELECT 1', { maxRows: 10, maxResultChars: 1000, timeoutMs: 5000 });
    expect(rows).toEqual([{ pid: '111' }]);
    expect(runRawQuery).toHaveBeenCalledWith(DS, 'SELECT 1', 10, expect.anything(), {
      maxResultChars: 1000,
      timeoutMs: 5000,
    });
  });

  it('throws on a cut result instead of returning part of it, without re-running the statement', async () => {
    runRawQuery.mockResolvedValue({ data: [{ pid: '111' }], rows: 1, meta: [], truncated: true });
    const error = await queryRows(DS, 'SELECT 1', { maxRows: 1, retryDelaysMs: [0] }).catch((e) => e);
    expect(error).toBeInstanceOf(TruncatedResultError);
    expect(error.maxRows).toBe(1);
    expect(isTransientError(error)).toBe(false);
    expect(runRawQuery).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures with the given delays', async () => {
    runRawQuery
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ data: [], rows: 0, meta: [], truncated: false });
    await expect(queryRows(DS, 'SELECT 1', { retryDelaysMs: [0] })).resolves.toEqual([]);
    expect(runRawQuery).toHaveBeenCalledTimes(2);
  });
});
