import { fetchKeepBehavior, normalizeBehaviorResult, normalizeResult, normalizeStaticData } from './assistantClient';
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

describe('fetchKeepBehavior', () => {
  const realFetch = global.fetch;
  const fetchMock = jest.fn();
  const row = (account: string, extra: Record<string, unknown> = {}) => ({
    pid: '111',
    account,
    days: 2,
    sessions: 5,
    engagementMin: 12.34,
    searchSessions: 1,
    searchNoPlaySessions: 1,
    browseNoPlaySessions: 0,
    crashes: 0,
    crashDays: 0,
    errorScreenSessions: 0,
    noInternetSessions: 0,
    accountVisits: 0,
    logoutClicks: 0,
    myListAdds: 0,
    myListRemoves: 0,
    platforms: ['ios'],
    ...extra,
  });
  const reply = (status: number, body: unknown) =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response);
  const sentBody = (call = 0) => JSON.parse(fetchMock.mock.calls[call][1].body);

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
    window.localStorage.setItem('analytix.aiAssistantUrl', 'http://localhost:8765');
    window.localStorage.setItem('analytix.aiAssistantToken', 'test-token');
  });

  afterEach(() => {
    global.fetch = realFetch;
    window.localStorage.removeItem('analytix.aiAssistantUrl');
    window.localStorage.removeItem('analytix.aiAssistantToken');
    jest.useRealTimers();
  });

  it('posts normalized accounts as JSON with the chat auth and returns the rows', async () => {
    fetchMock.mockReturnValue(
      reply(200, { status: 'on', window: { from: '2026-10-08', to: '2026-10-10', days: 3 }, rows: [row('AA111111')] })
    );
    const result = await fetchKeepBehavior({
      asOf: '2026-10-10',
      recentDays: 3,
      accountsByPid: { '111': ['aa-111-111', 'AA111111', 'AA111111_7', 'x', ' BB222222 '], "bad'pid": ['CC333333'] },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8765/api/keep/behavior');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.Authorization).toBe('Bearer test-token');
    expect(sentBody()).toEqual({
      asOf: '2026-10-10',
      recentDays: 3,
      accountsByPid: { '111': ['AA111111', 'BB222222'] },
    });
    expect(result.status).toBe('on');
    expect(result.window).toEqual({ from: '2026-10-08', to: '2026-10-10', days: 3 });
    expect(result.rows).toEqual([row('AA111111', { engagementMin: 12.3 })]);
    expect([result.matched, result.requested]).toEqual([1, 2]);
  });

  it('keeps only well-formed rows of the accounts asked about, numbers coerced and clamped', () => {
    const sent = new Map([['111', new Set(['AA111111', 'BB222222', 'CC333333'])]]);
    const result = normalizeBehaviorResult(
      {
        status: 'partial',
        reason: 'missing_days',
        window: { from: '2026-10-08', to: 'tomorrow', days: 2 },
        rows: [
          row('AA111111', {
            sessions: '7',
            crashes: -3,
            crashDays: 9,
            days: 99,
            engagementMin: 'NaN',
            platforms: ['ios', '<b>x</b>', 'tvos'],
          }),
          row('AA111111'),
          row('BB222222', { pid: '222' }),
          row('ZZ999999'),
          row('bb-222-222'),
          { pid: '111' },
          'junk',
        ],
      },
      sent
    );
    expect(result.status).toBe('partial');
    expect(result.message).toBe('Some GA4 days of the window are missing.');
    expect(result.window).toBeUndefined();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      sessions: 7,
      crashes: 0,
      days: 28,
      crashDays: 9,
      engagementMin: 0,
      platforms: ['ios', 'tvos'],
    });
    expect([result.matched, result.requested]).toEqual([1, 3]);
  });

  it('takes the counts from the backend: accounts of providers without GA4 are not linked, not unmatched', () => {
    const sent = new Map([
      ['111', new Set(['AA111111', 'BB222222'])],
      ['222', new Set(['CC333333', 'DD444444', 'EE555555'])],
    ]);
    const result = normalizeBehaviorResult(
      { status: 'on', requested: 2, matched: 1, notLinked: 3, rejectedPids: 1, rows: [row('AA111111')] },
      sent
    );
    expect([result.matched, result.requested, result.notLinked]).toEqual([1, 2, 3]);

    // Capped by what was sent; an answer without counts counts every sent account as requested.
    expect(
      normalizeBehaviorResult(
        { status: 'on', requested: 99, notLinked: '99', matched: 50, rows: [row('AA111111')] },
        sent
      )
    ).toMatchObject({ requested: 5, notLinked: 0, matched: 1 });
    expect(normalizeBehaviorResult({ status: 'on', requested: 2, notLinked: 9, rows: [] }, sent)).toMatchObject({
      requested: 2,
      notLinked: 3,
      matched: 0,
    });
    const old = normalizeBehaviorResult({ status: 'on', rows: [row('AA111111')] }, sent);
    expect([old.requested, old.notLinked]).toEqual([5, undefined]);
    expect(
      normalizeBehaviorResult({ status: 'off', reason: 'no_binding', requested: 0, notLinked: 5 }, sent)
    ).toMatchObject({ status: 'off', requested: 0, notLinked: 5, rows: [] });
  });

  it('turns an unknown status into an error and drops rows of non-data statuses', () => {
    expect(normalizeBehaviorResult({ status: 'great', rows: [row('AA111111')] })).toMatchObject({
      status: 'error',
      rows: [],
    });
    expect(
      normalizeBehaviorResult({ status: 'budget', reason: 'daily_budget', rows: [row('AA111111')] })
    ).toMatchObject({
      status: 'budget',
      rows: [],
      message: 'The daily GA4 query budget is used up.',
    });
    expect(normalizeBehaviorResult({ status: 'error', reason: 'Access Denied: project x' }).message).toBeUndefined();
    expect(normalizeBehaviorResult(null)).toMatchObject({ status: 'error', rows: [] });
  });

  it('maps refusals and older backends to unavailable, other HTTP errors to error', async () => {
    for (const code of [401, 403, 404]) {
      fetchMock.mockReturnValueOnce(reply(code, { error: 'x' }));
      expect(
        await fetchKeepBehavior({ asOf: '2026-10-10', recentDays: 7, accountsByPid: { '111': ['AA111111'] } })
      ).toMatchObject({
        status: 'unavailable',
        rows: [],
      });
    }
    fetchMock.mockReturnValueOnce(reply(429, { status: 'error', reason: 'rate_limit' }));
    expect(await fetchKeepBehavior({ asOf: '2026-10-10', recentDays: 7, accountsByPid: {} })).toMatchObject({
      status: 'error',
      message: 'Too many GA4 requests; try again in a minute.',
    });
    fetchMock.mockReturnValueOnce(reply(500, { error: 'internal error' }));
    expect((await fetchKeepBehavior({ asOf: '2026-10-10', recentDays: 7, accountsByPid: {} })).message).toBe(
      'GA4 evidence request failed (HTTP 500).'
    );
  });

  it('answers a network failure with a short error and rethrows the caller abort', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await fetchKeepBehavior({ asOf: '2026-10-10', recentDays: 7, accountsByPid: {} })).toMatchObject({
      status: 'error',
      message: 'The AI Insider service is unreachable.',
    });

    const controller = new AbortController();
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    );
    const pending = fetchKeepBehavior({ asOf: '2026-10-10', recentDays: 7, accountsByPid: {} }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });

  it('gives up after 150 s', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    );
    const pending = fetchKeepBehavior({ asOf: '2026-10-10', recentDays: 7, accountsByPid: {} });
    jest.advanceTimersByTime(150000);
    expect(await pending).toMatchObject({ status: 'error', message: 'GA4 evidence did not arrive in time.' });
  });

  it('sends batches of 2000 accounts and merges them; a failed batch fails the whole result', async () => {
    const accounts = Array.from({ length: 4500 }, (_, i) => `A${String(i).padStart(6, '0')}`);
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const sent: string[] = JSON.parse(String(init.body)).accountsByPid['111'];
      return reply(200, { status: sent.length === 500 ? 'partial' : 'on', rows: [row(sent[0])] });
    });
    const result = await fetchKeepBehavior({ asOf: '2026-10-10', recentDays: 7, accountsByPid: { '111': accounts } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect([2000, 2000, 500]).toEqual([0, 1, 2].map((i) => sentBody(i).accountsByPid['111'].length));
    expect(result.status).toBe('partial');
    expect(result.rows.map((r) => r.account)).toEqual(['A000000', 'A002000', 'A004000']);
    expect([result.matched, result.requested]).toEqual([3, 4500]);

    fetchMock.mockReset();
    fetchMock
      .mockReturnValueOnce(reply(200, { status: 'on', rows: [row('A000000')] }))
      .mockReturnValueOnce(reply(200, { status: 'budget', reason: 'daily_budget' }));
    expect(
      await fetchKeepBehavior({ asOf: '2026-10-10', recentDays: 7, accountsByPid: { '111': accounts } })
    ).toMatchObject({
      status: 'budget',
      rows: [],
      requested: 4500,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sums the backend counts over the batches, not linked apart from requested', async () => {
    // Pid 111 has GA4 bound, pid 222 does not: the backend counts 222 as not linked.
    const linked = Array.from({ length: 3000 }, (_, i) => `A${String(i).padStart(6, '0')}`);
    const unlinked = Array.from({ length: 1000 }, (_, i) => `B${String(i).padStart(6, '0')}`);
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const byPid: Record<string, string[]> = JSON.parse(String(init.body)).accountsByPid;
      const bound = byPid['111'] ?? [];
      return reply(200, {
        status: 'on',
        requested: bound.length,
        notLinked: (byPid['222'] ?? []).length,
        rejectedPids: byPid['222'] ? 1 : 0,
        matched: bound.length ? 1 : 0,
        rows: bound.length ? [row(bound[0])] : [],
      });
    });
    const result = await fetchKeepBehavior({
      asOf: '2026-10-10',
      recentDays: 7,
      accountsByPid: { '111': linked, '222': unlinked },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect([result.matched, result.requested, result.notLinked]).toEqual([2, 3000, 1000]);

    // A failed batch: the counts known so far, the rest counted as requested.
    fetchMock.mockReset();
    fetchMock
      .mockReturnValueOnce(reply(200, { status: 'on', requested: 1500, notLinked: 500, rows: [] }))
      .mockReturnValueOnce(reply(200, { status: 'pending', reason: 'in_progress', requested: 1500, notLinked: 500 }));
    expect(
      await fetchKeepBehavior({ asOf: '2026-10-10', recentDays: 7, accountsByPid: { '111': linked, '222': unlinked } })
    ).toMatchObject({ status: 'pending', rows: [], matched: 0, requested: 3000, notLinked: 1000 });
  });
});
