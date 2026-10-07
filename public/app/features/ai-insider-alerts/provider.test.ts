import { AlertEngine } from './engine';
import { AffectedUserRow, DEFAULT_RULES, ProviderBucketRow } from './types';

const DAY = 86400;
const B = 900;
const T0 = Date.UTC(2026, 9, 2, 3, 0) / 1000;

function bucket(pid: string, at: number, errUsers: number, users = 1000): ProviderBucketRow {
  return {
    bucket: at,
    pid,
    users,
    errUsers,
    srvErrUsers: 0,
    errEvents: errUsers * 2,
    topCode: '404/2004',
    topPlatform: 'iOS',
  };
}

/** Three previous days at the usual level for the window [T0, T0 + n buckets). */
function withBaseline(engine: AlertEngine, pids: string[], n: number, errUsers = 10) {
  for (let d = 1; d <= 3; d++) {
    const from = T0 - d * DAY;
    const rows = pids.flatMap((pid) => Array.from({ length: n }, (_, i) => bucket(pid, from + i * B, errUsers)));
    engine.ingestProviderBaseline(rows, from, from + n * B);
  }
}

function viewer(userId: string, firstErr: number, errEvents: number, spanSec: number): AffectedUserRow {
  return {
    incidentId: '',
    userId,
    platform: 'iOS',
    network: 'Wi-Fi',
    isp: 'Spectrum',
    city: 'New York',
    firstErr,
    lastErr: firstErr + spanSec,
    errEvents,
    topCode: '404/2004',
    watchedBeforeSec: 0,
  };
}

describe('AlertEngine provider level', () => {
  it('confirms a surge over the usual level and pushes only viewers who kept failing', () => {
    const engine = new AlertEngine(DEFAULT_RULES);
    withBaseline(engine, ['390'], 4);
    engine.ingestProviderBuckets(
      [bucket('390', T0, 60), bucket('390', T0 + B, 70), bucket('390', T0 + 2 * B, 12), bucket('390', T0 + 3 * B, 9)],
      T0,
      T0 + 4 * B
    );
    const windows = engine.takeProviderWindows();
    expect(windows).toHaveLength(1);
    engine.setProviderAffected(windows[0].id, [viewer('AA-1', T0 + 60, 5, 600), viewer('BB-2', T0 + 120, 1, 0)]);

    const [incident] = engine.getProviderIncidents();
    expect(incident).toMatchObject({ pid: '390', detectedAt: T0 + 2 * B, closedAt: T0 + 3 * B, recovered: true });
    expect(incident.peakRatio).toBe(7);
    expect(engine.getDecisions().map((d) => `${d.kind}:${d.userId}`)).toEqual([
      'down:AA-1',
      'in_app:BB-2',
      'back:AA-1',
    ]);
  });

  it('does not take a bigger audience with the usual error rate for an outage', () => {
    const engine = new AlertEngine(DEFAULT_RULES);
    withBaseline(engine, ['111'], 3, 20);
    // A match: three times the viewers and three times the errors, same 2% rate.
    engine.ingestProviderBuckets(
      [bucket('111', T0, 60, 3000), bucket('111', T0 + B, 66, 3300), bucket('111', T0 + 2 * B, 63, 3150)],
      T0,
      T0 + 3 * B
    );
    expect(engine.getProviderIncidents()).toHaveLength(0);
  });

  it('needs a baseline: the first day of a run detects nothing provider-wide', () => {
    const engine = new AlertEngine(DEFAULT_RULES);
    engine.ingestProviderBuckets([bucket('390', T0, 300), bucket('390', T0 + B, 300)], T0, T0 + 2 * B);
    expect(engine.getProviderIncidents()).toHaveLength(0);
  });

  it('groups providers surging at the same time as one infrastructure problem', () => {
    const engine = new AlertEngine(DEFAULT_RULES);
    withBaseline(engine, ['390', '465', '222'], 3);
    engine.ingestProviderBuckets(
      [
        bucket('390', T0, 80),
        bucket('465', T0, 90),
        bucket('390', T0 + B, 80),
        bucket('465', T0 + B, 90),
        bucket('390', T0 + 2 * B, 10),
        bucket('465', T0 + 2 * B, 10),
      ],
      T0,
      T0 + 3 * B
    );
    const incidents = engine.getProviderIncidents();
    expect(incidents).toHaveLength(2);
    expect(incidents[0].groupId).toBeDefined();
    expect(incidents[0].groupId).toBe(incidents[1].groupId);
    expect(engine.getSummary()).toMatchObject({ providerIncidents: 2, infraGroups: 1 });
  });

  it('keeps quiet about the service when a channel message reached the viewer first, and skips "your connection"', () => {
    const engine = new AlertEngine(DEFAULT_RULES);
    withBaseline(engine, ['222'], 3);
    // A channel outage on 222 confirmed and pushed at T0 + 5 min.
    const minute = (i: number, errUsers: number) => ({
      minute: T0 + i * 60,
      pid: '222',
      provider: '',
      cid: '20002549',
      title: 'Sport 1',
      users: 100,
      errUsers,
      errEvents: errUsers,
      srvErrUsers: errUsers,
      topPath: 'prn2/10008/live/hls/sport1',
      topHost: 'h',
      topPlatform: 'SmartTV',
      topCode: '404/1001',
    });
    engine.ingestMinutes([...Array.from({ length: 10 }, (_, i) => minute(i, 60))]);
    engine.advance(T0 + 10 * 60);
    for (const w of engine.takeIncidentWindows()) {
      engine.setAffectedUsers(w.id, [viewer('AA-1', T0, 5, 300)]);
    }
    engine.ingestProviderBuckets(
      [bucket('222', T0, 80), bucket('222', T0 + B, 80), bucket('222', T0 + 2 * B, 10)],
      T0,
      T0 + 3 * B
    );
    const [win] = engine.takeProviderWindows();
    engine.setProviderAffected(win.id, [viewer('AA-1', T0 + 20 * 60, 6, 300)]);
    engine.ingestCustomerSide([
      {
        pid: '222',
        provider: '',
        userId: 'CC-3',
        platform: 'Android',
        network: 'Wi-Fi',
        isp: 'X',
        city: 'Y',
        channels: 4,
        minutes: 5,
        errEvents: 9,
        firstMinute: T0 + 60,
        lastMinute: T0 + 6 * 60,
        topCode: '-/2001',
      },
    ]);

    const decisions = engine.getDecisions();
    const service = decisions.filter((d) => d.incidentId === win.id);
    expect(service.map((d) => d.kind)).toEqual(['suppressed']);
    expect(service[0].reason).toContain('channel outage');
    expect(decisions.filter((d) => d.kind === 'diagnosis')).toHaveLength(0);
  });
});
