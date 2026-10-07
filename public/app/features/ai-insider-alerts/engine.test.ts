import { AlertEngine } from './engine';
import { AffectedUserRow, BadMinuteRow, DEFAULT_RULES } from './types';

const T0 = Date.UTC(2026, 8, 29, 17, 0) / 1000;
const MIN = 60;

function bad(minuteOffset: number, overrides: Partial<BadMinuteRow> = {}): BadMinuteRow {
  return {
    minute: T0 + minuteOffset * MIN,
    pid: '222',
    provider: '',
    cid: '20002549',
    title: 'Sport 1',
    users: 100,
    errUsers: 60,
    errEvents: 120,
    srvErrUsers: 55,
    topPath: 'prn2/10008/live-drm/dash/artpulse1',
    topHost: 'nimialb.rixnode.net',
    topPlatform: 'SmartTV',
    topCode: '403/1001',
    ...overrides,
  };
}

/** A watched minute without errors: evidence of recovery. */
function clean(minuteOffset: number, overrides: Partial<BadMinuteRow> = {}): BadMinuteRow {
  return bad(minuteOffset, { errUsers: 0, errEvents: 0, srvErrUsers: 0, ...overrides });
}

/** Still failing for the few who watch, below the incident thresholds. */
function thin(minuteOffset: number): BadMinuteRow {
  return bad(minuteOffset, { users: 6, errUsers: 4, errEvents: 6, srvErrUsers: 4 });
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

function user(userId: string, firstErr: number, overrides: Partial<AffectedUserRow> = {}): AffectedUserRow {
  return {
    incidentId: '',
    userId,
    platform: 'SmartTV',
    network: 'Wi-Fi',
    isp: 'Test ISP',
    city: 'Tirana',
    firstErr,
    lastErr: firstErr + 5 * MIN,
    errEvents: 12,
    topCode: '403/1001',
    watchedBeforeSec: 0,
    ...overrides,
  };
}

/** Feeds the minutes, closes the window and attaches viewers to every incident that asks. */
function run(engine: AlertEngine, rows: BadMinuteRow[], until: number, users: (id: string) => AffectedUserRow[]) {
  engine.ingestBadMinutes(rows);
  engine.advance(until);
  for (const w of engine.takeIncidentWindows()) {
    engine.setAffectedUsers(w.id, users(w.id));
  }
}

describe('AlertEngine', () => {
  it('confirms, escalates and closes a long outage, with down, back and apology messages', () => {
    const engine = new AlertEngine(DEFAULT_RULES);
    const rows = [...range(0, 10).map((i) => bad(i)), ...range(10, 15).map((i) => clean(i))];
    run(engine, rows, T0 + 60 * MIN, () => [
      user('AA-111-111', T0, { watchedBeforeSec: 30 * MIN }),
      user('BB-222-222', T0 + 7 * MIN, { errEvents: 1 }),
    ]);

    const [incident] = engine.getIncidents();
    expect(incident.detectedAt).toBe(T0 + 2 * MIN);
    expect(incident.escalatedAt).toBe(T0 + 5 * MIN);
    // Five clean minutes +10..+14: back at the end of the fifth one.
    expect(incident.closedAt).toBe(T0 + 15 * MIN);
    expect(incident.recovered).toBe(true);
    expect(engine.incidentClass(incident)).toBe('push');

    const kinds = engine.getDecisions().map((d) => `${d.kind}:${d.userId}:${(d.at - T0) / MIN}`);
    expect(kinds).toEqual([
      'down:AA-111-111:5',
      'suppressed:AA-111-111:5',
      'down:BB-222-222:7',
      'back:AA-111-111:15',
      'apology:AA-111-111:15',
      'back:BB-222-222:15',
    ]);
    const summary = engine.getSummary();
    expect(summary.down).toBe(2);
    expect(summary.suppressedRepeats).toBe(11);
  });

  it('keeps a blip that recovers before the push delay in the player only', () => {
    const engine = new AlertEngine(DEFAULT_RULES);
    run(engine, [bad(0), bad(1), ...range(2, 7).map((i) => clean(i))], T0 + 30 * MIN, () => [
      user('AA-111-111', T0 + MIN, { lastErr: T0 + 2 * MIN }),
      // Failed and left before the detector knew: nothing to tell.
      user('CC-333-333', T0, { lastErr: T0 + 30 }),
    ]);

    const [incident] = engine.getIncidents();
    expect(engine.incidentClass(incident)).toBe('in_app');
    const decisions = engine.getDecisions();
    expect(decisions.map((d) => `${d.kind}:${d.userId}`)).toEqual(['in_app:AA-111-111']);
  });

  it('does not call a channel back when its audience only thinned out', () => {
    const engine = new AlertEngine(DEFAULT_RULES);
    // Sport 1 on 2026-09-29 14:13-14:19: 4 of 6 viewers failing, too few for
    // a "bad" minute, yet nothing like a recovery.
    const rows = [
      ...range(0, 6).map((i) => bad(i)),
      ...range(6, 13).map((i) => thin(i)),
      ...range(13, 16).map((i) => bad(i)),
      ...range(16, 21).map((i) => clean(i)),
    ];
    run(engine, rows, T0 + 60 * MIN, () => [user('AA-111-111', T0)]);

    const incidents = engine.getIncidents();
    expect(incidents).toHaveLength(1);
    expect(incidents[0].closedAt).toBe(T0 + 21 * MIN);
    expect(engine.getDecisions().filter((d) => d.kind === 'back')).toHaveLength(1);
  });

  it('closes silently, without a "back" message, when nobody watches after the outage', () => {
    const engine = new AlertEngine(DEFAULT_RULES);
    run(
      engine,
      range(0, 6).map((i) => bad(i)),
      T0 + 120 * MIN,
      () => [user('AA-111-111', T0)]
    );

    const [incident] = engine.getIncidents();
    expect(incident.recovered).toBe(false);
    expect(incident.closedAt).toBe(T0 + (5 + 1 + DEFAULT_RULES.quietCloseMinutes) * MIN);
    expect(engine.getDecisions().map((d) => d.kind)).toEqual(['down', 'suppressed']);
  });

  it('drops a single failing minute as noise', () => {
    const engine = new AlertEngine(DEFAULT_RULES);
    run(engine, [bad(0)], T0 + 30 * MIN, () => []);
    expect(engine.getIncidents()).toHaveLength(0);
    expect(engine.blipCount).toBe(1);
  });

  it('does not tell a viewer twice about a flapping channel inside the cooldown', () => {
    const engine = new AlertEngine(DEFAULT_RULES);
    const first = [...range(0, 6).map((i) => bad(i)), ...range(6, 11).map((i) => clean(i))];
    const second = range(20, 26).map((i) => bad(i));
    run(engine, [...first, ...second], T0 + 60 * MIN, (id) => [
      user('AA-111-111', id === engine.getIncidents().at(-1)?.id ? T0 : T0 + 20 * MIN),
    ]);

    const incidents = engine.getIncidents();
    expect(incidents).toHaveLength(2);
    expect(incidents[0].reopenOf).toBe(incidents[1].id);
    const kinds = engine
      .getDecisions()
      .filter((d) => d.userId === 'AA-111-111')
      .map((d) => d.kind);
    expect(kinds.filter((k) => k === 'down')).toHaveLength(1);
    expect(kinds).toContain('suppressed');
    expect(engine.getSummary().suppressedCooldown).toBe(1);
  });

  it('groups the same source stream failing on two providers at once', () => {
    const engine = new AlertEngine(DEFAULT_RULES);
    const path = { topPath: 'prn2/10008/live/hls/Topchannel' };
    const rows = [0, 1, 2].flatMap((i) => [
      bad(i, { pid: '111', cid: '2229', title: 'TOP CHANNEL', ...path }),
      bad(i, { pid: '222', cid: '20002305', title: 'Top Channel', ...path }),
    ]);
    run(engine, rows, T0 + 30 * MIN, () => []);

    const groups = engine.getGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].incidentIds).toHaveLength(2);
    expect(groups[0].label).toContain('2 providers');
  });

  it('marks an incident on a dead channel chronic and never pushes', () => {
    const engine = new AlertEngine(DEFAULT_RULES);
    engine.ingestChannelHealth(
      [{ pid: '642', provider: '', cid: '1725', title: 'K SPORT 2', srvErrUsers: 9, okUsers: 0, triedUsers: 12 }],
      T0 - 60 * MIN,
      T0
    );
    const rows = Array.from({ length: 10 }, (_, i) => bad(i, { pid: '642', cid: '1725', title: 'K SPORT 2' }));
    run(engine, rows, T0 + 60 * MIN, () => [user('AA-111-111', T0)]);

    const [incident] = engine.getIncidents();
    expect(engine.incidentClass(incident)).toBe('chronic');
    expect(engine.getDecisions().map((d) => d.kind)).toEqual(['in_app']);
    expect(engine.getDeadChannels()).toHaveLength(1);
  });

  it('gives one customer-side diagnosis per viewer per day across overlapping windows', () => {
    const engine = new AlertEngine(DEFAULT_RULES);
    const row = {
      pid: '222',
      provider: '',
      userId: 'AA-111-111',
      platform: 'Android',
      network: 'Wi-Fi',
      isp: 'Test ISP',
      city: 'Tirana',
      channels: 3,
      minutes: 4,
      errEvents: 9,
      firstMinute: T0,
      lastMinute: T0 + 4 * MIN,
      topCode: '-/2001',
    };
    engine.ingestCustomerSide([row]);
    engine.ingestCustomerSide([{ ...row, minutes: 6, lastMinute: T0 + 6 * MIN }]);
    const diagnoses = engine.getDecisions().filter((d) => d.kind === 'diagnosis');
    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0].at).toBe(T0 + 7 * MIN);
  });
});
