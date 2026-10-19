// Shared fixture of the results views: two channel incidents of provider 222
// (Sport 1 pushed and recovered, Top Channel a short blip), one viewer each.

import type { AlertsSnapshot } from '../AlertsResults';
import { AlertEngine } from '../engine';
import { BadMinuteRow, DEFAULT_RULES } from '../types';

export const T0 = Date.UTC(2026, 8, 29, 17, 0) / 1000;
export const MIN = 60;

function bad(i: number, overrides: Partial<BadMinuteRow> = {}): BadMinuteRow {
  return {
    minute: T0 + i * MIN,
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

export function snapshot(): AlertsSnapshot {
  const engine = new AlertEngine(DEFAULT_RULES);
  engine.setProviderNames({ '222': 'NimiTV' });
  const clean = (i: number, cid = '20002549') => bad(i, { cid, errUsers: 0, errEvents: 0, srvErrUsers: 0 });
  engine.ingestMinutes([
    ...Array.from({ length: 10 }, (_, i) => bad(i)),
    ...Array.from({ length: 5 }, (_, i) => clean(10 + i)),
    bad(30, { cid: '20002305', title: 'Top Channel' }),
    bad(31, { cid: '20002305', title: 'Top Channel' }),
    ...Array.from({ length: 5 }, (_, i) => clean(32 + i, '20002305')),
  ]);
  engine.advance(T0 + 60 * MIN);
  for (const w of engine.pendingIncidentWindows()) {
    engine.setAffectedUsers(w.id, [
      {
        incidentId: w.id,
        userId: `AA-${w.cid.slice(-3)}-001`,
        platform: 'SmartTV',
        network: 'Wi-Fi',
        isp: 'Test ISP',
        city: 'Tirana',
        firstErr: w.start + 30,
        lastErr: w.start + 5 * MIN,
        errEvents: 7,
        topCode: '403/1001',
        watchedBeforeSec: 20 * MIN,
      },
    ]);
  }
  engine.ingestErrorVolume({ errEvents: 500, errUsers: 20, userErrMinutes: 90 });
  return {
    summary: engine.getSummary(),
    incidents: engine.getIncidents(),
    decisions: engine.getDecisions(),
    customer: engine.getCustomerSide(),
    dead: engine.getDeadChannels(),
    channels: engine.getChannelReport(),
    providers: engine.getProviderIncidents(),
    activity: engine.getActivityIncidents(),
    providerAffected: (id) => engine.getProviderAffected(id),
    groups: engine.getGroups(),
    blips: engine.blipCount,
    classOf: (i) => engine.incidentClass(i),
    affected: (id) => engine.getAffectedUsers(id),
    from: T0,
    to: T0 + 60 * MIN,
  };
}
