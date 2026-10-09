import { normalizeResult, normalizeStaticData } from './assistantClient';
import { SUPPORTED_PANEL_TYPES } from './types';

// Contract pin, mirrored by test/contract.test.mjs in the analytix-ai-insider
// service: if either side changes the panel-type list or the spec fields, its
// own suite fails. Update both pins together, deliberately.
describe('panel spec contract', () => {
  it('pins the supported panel types', () => {
    expect([...SUPPORTED_PANEL_TYPES]).toEqual([
      'timeseries',
      'piechart',
      'table',
      'stat',
      'barchart',
      'gauge',
      'bargauge',
      'histogram',
      'heatmap',
      'state-timeline',
      'status-history',
      'trend',
      'xychart',
    ]);
  });
});

describe('normalizeResult', () => {
  const goodSpec = {
    panelType: 'timeseries',
    title: 'Watch time',
    rawSql: 'SELECT t, v FROM stat.agg',
    timeFrom: 'now-30d',
    timeTo: 'now',
  };

  it('accepts a valid spec and passes the metadata through', () => {
    const r = normalizeResult({ spec: goodSpec, message: 'done', sessionId: 's1', durationMs: 1200, costUsd: 0.5 });
    expect(r.spec).toEqual(goodSpec);
    expect(r.message).toBe('done');
    expect(r.sessionId).toBe('s1');
    expect(r.durationMs).toBe(1200);
    expect(r.costUsd).toBe(0.5);
  });

  it('drops a spec whose SQL fails the read-only gate, keeping the message', () => {
    const r = normalizeResult({ spec: { ...goodSpec, rawSql: 'INSERT INTO t VALUES (1)' }, message: 'm' });
    expect(r.spec).toBeNull();
    expect(r.message).toBe('m');
    expect(normalizeResult({ spec: { ...goodSpec, rawSql: 'SELECT 1; DROP TABLE t' } }).spec).toBeNull();
    expect(normalizeResult({ spec: { ...goodSpec, rawSql: "SELECT * FROM url('http://x/')" } }).spec).toBeNull();
  });

  it('drops a spec with an unknown panel type', () => {
    expect(normalizeResult({ spec: { ...goodSpec, panelType: 'geomap' } }).spec).toBeNull();
  });

  it('accepts the newly supported chart types', () => {
    expect(normalizeResult({ spec: { ...goodSpec, panelType: 'state-timeline' } }).spec?.panelType).toBe(
      'state-timeline'
    );
    expect(normalizeResult({ spec: { ...goodSpec, panelType: 'gauge' } }).spec?.panelType).toBe('gauge');
  });

  it('sanitizes time expressions, keeping valid Grafana ones', () => {
    const r = normalizeResult({ spec: { ...goodSpec, timeFrom: 'javascript:alert(1)', timeTo: 'now/d' } });
    expect(r.spec?.timeFrom).toBeUndefined();
    expect(r.spec?.timeTo).toBe('now/d');
    expect(normalizeResult({ spec: { ...goodSpec, timeFrom: '2026-01-01T00:00:00Z' } }).spec?.timeFrom).toBe(
      '2026-01-01T00:00:00Z'
    );
  });

  it('survives a malformed payload', () => {
    expect(normalizeResult(undefined).spec).toBeNull();
    expect(normalizeResult({ spec: 'not-an-object' }).spec).toBeNull();
    expect(normalizeResult({}).message).toBe('');
  });
});

describe('normalizeResult — GA4 panels', () => {
  const ga4Spec = {
    panelType: 'barchart',
    title: 'My List entries',
    rawSql: '',
    source: 'ga4',
    data: {
      fields: [
        { name: 'streamName', type: 'string' },
        { name: 'eventCount', type: 'number' },
      ],
      rows: [
        ['Android', 871],
        ['iOS', 265],
      ],
    },
    query: '{"kind":"report"}',
  };

  it('accepts a well-formed static frame without SQL', () => {
    const r = normalizeResult({ spec: ga4Spec });
    expect(r.spec).toEqual({
      panelType: 'barchart',
      title: 'My List entries',
      rawSql: '',
      source: 'ga4',
      data: ga4Spec.data,
      timeFrom: undefined,
      timeTo: undefined,
    });
  });

  it('drops a malformed frame instead of rendering it', () => {
    expect(normalizeResult({ spec: { ...ga4Spec, data: { fields: [], rows: [] } } }).spec).toBeNull();
    expect(
      normalizeResult({ spec: { ...ga4Spec, data: { fields: [{ name: 'x', type: 'blob' }], rows: [] } } }).spec
    ).toBeNull();
    expect(
      normalizeResult({ spec: { ...ga4Spec, data: { fields: ga4Spec.data.fields, rows: [['only one cell']] } } }).spec
    ).toBeNull();
  });

  it('never lets a GA4-labelled spec smuggle SQL through', () => {
    const r = normalizeResult({ spec: { ...ga4Spec, rawSql: 'SELECT 1', data: undefined } });
    expect(r.spec).toBeNull();
  });
});

describe('normalizeStaticData', () => {
  it('coerces cells to the declared types', () => {
    const data = normalizeStaticData({
      fields: [
        { name: 'date', type: 'time' },
        { name: 'label', type: 'string' },
        { name: 'n', type: 'number' },
      ],
      rows: [[1790899200000, 42, 'x']],
    });
    expect(data?.rows).toEqual([[1790899200000, '42', null]]);
  });
});
