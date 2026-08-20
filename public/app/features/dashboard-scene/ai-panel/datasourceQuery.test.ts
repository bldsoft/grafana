import { isSafeBridgeSql } from './datasourceQuery';

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
