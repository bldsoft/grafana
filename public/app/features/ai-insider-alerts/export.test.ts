import { runDatasetExport } from './export';
import { DEFAULT_RULES } from './types';

const runRawQuery = jest.fn();

jest.mock('app/features/dashboard-scene/ai-panel/datasourceQuery', () => ({
  runRawQuery: (...args: unknown[]) => runRawQuery(...args),
}));

const H0 = Date.UTC(2026, 8, 29, 17) / 1000;

/** Answers by query shape: discovery (HAVING), channel minutes, viewer errors, health. */
function answer(sql: string) {
  const hour = Number(/event_timestamp >= toDateTime\((\d+)\)/.exec(sql)?.[1]);
  if (sql.includes('HAVING users >=')) {
    // Sport 1 fails only in the first hour.
    return hour === H0 ? [{ pid: '222', cid: '20002549' }] : [];
  }
  if (sql.includes('(content_provider_id, event_parameter1) IN')) {
    return [{ minute_ts: hour, pid: '222', cid: '20002549', users: 10, err_users: hour === H0 ? 6 : 0 }];
  }
  if (sql.includes('GROUP BY minute, pid, cid, user_id')) {
    return hour === H0 ? [{ minute_ts: hour, pid: '222', cid: '20002549', user_id: 'AA-111-111', isp_any: 'ISP' }] : [];
  }
  return [];
}

describe('runDatasetExport', () => {
  beforeEach(() => {
    runRawQuery.mockReset();
    runRawQuery.mockImplementation((_ds: unknown, sql: string) =>
      Promise.resolve({ data: answer(sql), truncated: false })
    );
  });

  it('writes NDJSON lines and keeps following a channel one hour after it last failed', async () => {
    const progress: number[] = [];
    const { blob } = await runDatasetExport({
      datasource: { uid: 'ch', type: 'grafana-clickhouse-datasource' },
      pids: ['222'],
      from: H0,
      to: H0 + 3 * 3600,
      rules: DEFAULT_RULES,
      signal: new AbortController().signal,
      onChunk: (clock) => progress.push(clock),
    });

    const lines = (await blob.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ t: 'meta', format: 'ai-insider-alerts-dataset', from: H0, pids: ['222'] });
    const minCols = lines.find((l) => l.t === 'columns' && l.type === 'min').columns;
    const rows = (type: string) =>
      lines
        .filter((l) => Array.isArray(l) && l[0] === type)
        .map((l) => Object.fromEntries(minCols.map((c: string, i: number) => [c, l[i + 1]])));
    // Minutes for hour 1 (failing) and hour 2 (carried over), not hour 3.
    expect(rows('min').map((r) => r.minute_ts)).toEqual([H0, H0 + 3600]);
    expect(lines.filter((l) => Array.isArray(l) && l[0] === 'err')).toHaveLength(1);
    expect(lines.filter((l) => l.t === 'columns').map((l) => l.type)).toEqual(['min', 'err']);
    expect(progress).toEqual([H0 + 3600, H0 + 7200, H0 + 10800]);
  });

  it('re-reads a cut result in half windows instead of losing the rest of the hour', async () => {
    // The viewer-error query only fits for windows of 15 minutes or less;
    // every minute of the hour has one row.
    runRawQuery.mockImplementation((_ds: unknown, sql: string) => {
      if (!sql.includes('GROUP BY minute, pid, cid, user_id')) {
        return Promise.resolve({ data: [], truncated: false });
      }
      const [from, to] = [...sql.matchAll(/toDateTime\((\d+)\)/g)].map((m) => Number(m[1]));
      if (to - from > 900) {
        return Promise.resolve({ data: [{ minute_ts: from }], truncated: true });
      }
      const rows = [];
      for (let t = from; t < to; t += 60) {
        rows.push({ minute_ts: t, pid: '111', cid: '1', user_id: `U${t}` });
      }
      return Promise.resolve({ data: rows, truncated: false });
    });

    const { blob } = await runDatasetExport({
      datasource: { uid: 'ch', type: 'grafana-clickhouse-datasource' },
      pids: null,
      from: H0,
      to: H0 + 3600,
      rules: DEFAULT_RULES,
      signal: new AbortController().signal,
      onChunk: () => {},
    });
    const errRows = (await blob.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((l) => Array.isArray(l) && l[0] === 'err');
    expect(errRows).toHaveLength(60);
  });

  it('retries a 502 from the proxy and keeps going', async () => {
    let failures = 2;
    runRawQuery.mockImplementation((_ds: unknown, sql: string) => {
      if (sql.includes('GROUP BY minute, pid, cid, user_id') && failures > 0) {
        failures -= 1;
        return Promise.reject(new Error('error querying the database: 502 Bad Gateway'));
      }
      return Promise.resolve({ data: answer(sql), truncated: false });
    });
    const result = await runDatasetExport({
      datasource: { uid: 'ch', type: 'grafana-clickhouse-datasource' },
      pids: ['222'],
      from: H0,
      to: H0 + 2 * 3600,
      rules: DEFAULT_RULES,
      signal: new AbortController().signal,
      onChunk: () => {},
      retryDelaysMs: [0, 0, 0],
    });
    expect(result.complete).toBe(true);
    expect(result.upTo).toBe(H0 + 2 * 3600);
  });

  it('saves every complete hour when a query keeps failing, and says where it stopped', async () => {
    runRawQuery.mockImplementation((_ds: unknown, sql: string) => {
      const from = Number(/event_timestamp >= toDateTime\((\d+)\)/.exec(sql)?.[1]);
      if (from >= H0 + 3600) {
        return Promise.reject(new Error('502 Bad Gateway'));
      }
      return Promise.resolve({ data: answer(sql), truncated: false });
    });
    const result = await runDatasetExport({
      datasource: { uid: 'ch', type: 'grafana-clickhouse-datasource' },
      pids: ['222'],
      from: H0,
      to: H0 + 3 * 3600,
      rules: DEFAULT_RULES,
      signal: new AbortController().signal,
      onChunk: () => {},
      retryDelaysMs: [0],
    });
    expect(result).toMatchObject({ complete: false, upTo: H0 + 3600 });
    expect(result.error).toContain('502');
    const lines = (await result.blob.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines[lines.length - 1]).toMatchObject({ t: 'end', complete: false, upTo: H0 + 3600 });
    expect(lines.filter((l) => Array.isArray(l) && l[0] === 'err')).toHaveLength(1);
  });
});
