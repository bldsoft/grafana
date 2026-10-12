import { NEVER, of } from 'rxjs';

import { FieldType, toDataFrame } from '@grafana/data';
import { DataSourceWithBackend } from '@grafana/runtime';

import {
  CLICKHOUSE_FORMAT_TABLE,
  isSafeBridgeSql,
  OFFICIAL_CLICKHOUSE_PLUGIN_ID,
  rawSqlQuery,
  runRawFrame,
  runRawQuery,
} from './datasourceQuery';

const mockQuery = jest.fn();
let mockDatasource: unknown;

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getDataSourceSrv: () => ({ get: () => Promise.resolve(mockDatasource) }),
}));

describe('rawSqlQuery', () => {
  it('asks the official plugin for raw table rows (no server-side long-to-wide)', () => {
    expect(rawSqlQuery({ uid: 'u', type: OFFICIAL_CLICKHOUSE_PLUGIN_ID }, 'SELECT 1')).toEqual({
      refId: 'A',
      rawSql: 'SELECT 1',
      query: 'SELECT 1',
      format: CLICKHOUSE_FORMAT_TABLE,
    });
  });

  it('leaves the community plugin on its own format default', () => {
    expect(rawSqlQuery({ uid: 'u', type: 'vertamedia-clickhouse-datasource' }, 'SELECT 1', 'B')).toEqual({
      refId: 'B',
      rawSql: 'SELECT 1',
      query: 'SELECT 1',
    });
    expect(rawSqlQuery({ uid: 'u' }, 'SELECT 1')).not.toHaveProperty('format');
  });
});

describe('isSafeBridgeSql', () => {
  it('allows single read-only statements', () => {
    expect(isSafeBridgeSql('SELECT count() FROM stat.events WHERE t > now() - INTERVAL 1 DAY')).toBe(true);
    expect(isSafeBridgeSql('  WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true);
    expect(isSafeBridgeSql('SHOW DATABASES')).toBe(true);
    expect(isSafeBridgeSql('DESCRIBE TABLE stat.events')).toBe(true);
  });

  it('rejects mutations and multi-statement input', () => {
    expect(isSafeBridgeSql('INSERT INTO t VALUES (1)')).toBe(false);
    expect(isSafeBridgeSql('SELECT 1; DROP TABLE t')).toBe(false);
    expect(isSafeBridgeSql('ALTER TABLE t DELETE WHERE 1')).toBe(false);
  });

  it('rejects system schemas', () => {
    expect(isSafeBridgeSql('SELECT * FROM system.processes')).toBe(false);
    expect(isSafeBridgeSql('SELECT * FROM information_schema.tables')).toBe(false);
  });

  it('rejects external table functions including unlisted storage variants and aliases', () => {
    expect(isSafeBridgeSql("SELECT * FROM url('http://169.254.169.254/')")).toBe(false);
    expect(isSafeBridgeSql("SELECT * FROM s3('http://x/', CSV)")).toBe(false);
    // `\w*` on the storage families catches variants an enumerated list missed.
    expect(isSafeBridgeSql("SELECT * FROM icebergS3('http://x/')")).toBe(false);
    expect(isSafeBridgeSql("SELECT * FROM deltaLakeAzure('...')")).toBe(false);
    expect(isSafeBridgeSql("SELECT * FROM hdfsCluster('...')")).toBe(false);
    // s3 aliases (cosn/gcs/oss) share the external-URL surface.
    expect(isSafeBridgeSql("SELECT * FROM cosn('http://x/', 'CSV')")).toBe(false);
    expect(isSafeBridgeSql("SELECT * FROM gcs('http://x/')")).toBe(false);
    expect(isSafeBridgeSql("SELECT * FROM oss('http://x/')")).toBe(false);
  });

  it('rejects functions/schemas hidden behind SQL comments', () => {
    // ClickHouse treats comments as token separators; the gate must too.
    expect(isSafeBridgeSql("SELECT * FROM url/**/('http://169.254.169.254/')")).toBe(false);
    expect(isSafeBridgeSql("SELECT * FROM s3 /* c */ ('http://x/')")).toBe(false);
    expect(isSafeBridgeSql('SELECT * FROM system/**/.processes')).toBe(false);
    expect(isSafeBridgeSql('SELECT 1 -- ok\nUNION SELECT * FROM url(\'http://x/\')')).toBe(false);
  });

  it('keeps legitimate functions that merely share a prefix, and leading comments', () => {
    expect(isSafeBridgeSql('SELECT URLHierarchy(page_url) FROM stat.events')).toBe(true);
    expect(isSafeBridgeSql('SELECT filesystemAvailable()')).toBe(true);
    expect(isSafeBridgeSql('/* dashboard: watch time */ SELECT 1')).toBe(true);
  });
});

describe('runRawFrame / runRawQuery', () => {
  const DS = { uid: 'ch', type: OFFICIAL_CLICKHOUSE_PLUGIN_ID };
  const T0 = Date.UTC(2026, 9, 5);
  const frame = toDataFrame({
    fields: [
      { name: 'pid', type: FieldType.string, values: ['111', '222', '333'] },
      { name: 'events', type: FieldType.number, values: [5, 7, 9] },
      { name: 'ts', type: FieldType.time, values: [T0, T0, T0] },
    ],
  });

  beforeAll(() => {
    // jsdom has no crypto.randomUUID; the request id only needs to be unique.
    if (typeof crypto.randomUUID !== 'function') {
      let n = 0;
      Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => `test-${++n}` });
    }
  });

  beforeEach(() => {
    mockQuery.mockReset();
    mockDatasource = Object.assign(Object.create(DataSourceWithBackend.prototype), { query: mockQuery });
  });

  it('returns the first frame column by column, without a row cap or row objects', async () => {
    mockQuery.mockReturnValue(of({ data: [frame, toDataFrame({ fields: [] })] }));
    const result = await runRawFrame(DS, 'SELECT pid, events, ts FROM t');
    expect(result.length).toBe(3);
    expect(result.fields.map((f) => [f.name, f.type])).toEqual([
      ['pid', FieldType.string],
      ['events', FieldType.number],
      ['ts', FieldType.time],
    ]);
    // The datasource's own arrays: times stay epoch milliseconds.
    expect(Array.from(result.fields[1].values)).toEqual([5, 7, 9]);
    expect(result.fields[2].values[0]).toBe(T0);
    const request = mockQuery.mock.calls[0][0];
    expect(request.targets[0]).toMatchObject({
      rawSql: 'SELECT pid, events, ts FROM t',
      format: CLICKHOUSE_FORMAT_TABLE,
    });
  });

  it('keeps runRawQuery rows, ISO times and the row cap as before', async () => {
    mockQuery.mockReturnValue(of({ data: [frame] }));
    const result = await runRawQuery(DS, 'SELECT pid, events, ts FROM t', 2);
    expect(result.data).toEqual([
      { pid: '111', events: 5, ts: new Date(T0).toISOString() },
      { pid: '222', events: 7, ts: new Date(T0).toISOString() },
    ]);
    expect(result.truncated).toBe(true);
    expect(result.meta).toEqual([
      { name: 'pid', type: FieldType.string },
      { name: 'events', type: FieldType.number },
      { name: 'ts', type: FieldType.time },
    ]);
  });

  it('answers an empty result with an empty frame', async () => {
    mockQuery.mockReturnValue(of({ data: [] }));
    await expect(runRawFrame(DS, 'SELECT 1')).resolves.toEqual({ length: 0, fields: [] });
    await expect(runRawQuery(DS, 'SELECT 1', 10)).resolves.toEqual({ data: [], rows: 0, meta: [], truncated: false });
  });

  it('shares the gate: nothing but a single read-only statement reaches the datasource', async () => {
    await expect(runRawFrame(DS, 'SELECT 1; DROP TABLE t')).rejects.toThrow('client-side gate');
    await expect(runRawQuery(DS, 'ALTER TABLE t DELETE WHERE 1', 10)).rejects.toThrow('client-side gate');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('throws the datasource error text', async () => {
    mockQuery.mockReturnValue(of({ data: [], errors: [{ message: 'Code: 159. DB::Exception: Timeout exceeded' }] }));
    await expect(runRawFrame(DS, 'SELECT 1')).rejects.toThrow('Timeout exceeded');
  });

  it("gives up after the caller's wait and names it", async () => {
    mockQuery.mockReturnValue(NEVER);
    await expect(runRawFrame(DS, 'SELECT 1', undefined, { timeoutMs: 20 })).rejects.toThrow(
      'The datasource did not answer within 0.02s.'
    );
    await expect(runRawQuery(DS, 'SELECT 1', 10, undefined, { timeoutMs: 20 })).rejects.toThrow(
      'did not answer within 0.02s'
    );
  });

  it('cancels on abort', async () => {
    mockQuery.mockReturnValue(NEVER);
    const controller = new AbortController();
    const pending = runRawFrame(DS, 'SELECT 1', controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('Query cancelled.');
  });
});
