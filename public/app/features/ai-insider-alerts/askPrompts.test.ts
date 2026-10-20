import { activityPrompt, channelPrompt, providerPrompt, utcWindow } from './askPrompts';
import { MIN, T0, snapshot } from './fixtures/snapshot';
import type { ActivityIncident, ProviderIncident } from './types';

const T = Date.UTC(2026, 9, 10, 18, 0) / 1000;

describe('utcWindow', () => {
  it('names the date once within a day, both ends across midnight', () => {
    expect(utcWindow(T, T + 45 * MIN)).toBe('on 2026-10-10 18:00–18:45 UTC');
    expect(utcWindow(T, T + 7 * 60 * MIN)).toBe('on 2026-10-10 18:00–2026-10-11 01:00 UTC');
  });

  it('says when it is still going on', () => {
    expect(utcWindow(T, undefined)).toBe('since 2026-10-10 18:00 UTC (still ongoing)');
  });
});

describe('prompts', () => {
  it('describes a channel incident with its stream and asks for a breakdown', () => {
    const sport = snapshot().incidents.find((i) => i.title === 'Sport 1')!;
    const prompt = channelPrompt(sport);

    expect(prompt).toContain('Channel Sport 1 (id 20002549) of provider 222 (NimiTV) failed on 2026-09-29 17:00–');
    expect(prompt).toContain('up to 60 of 100 viewers (60%)');
    expect(prompt).toContain('Stream: prn2/10008/live-drm/dash/artpulse1.');
    expect(prompt).toContain('Error codes: 403/1001');
    expect(prompt).toMatch(/minute by minute/);
  });

  it('describes a provider surge against its usual level', () => {
    const incident: ProviderIncident = {
      id: 'prov-111-1',
      pid: '111',
      provider: 'TVALB',
      start: T,
      detectedAt: T + 30 * MIN,
      lastSurge: T + 30 * MIN,
      closedAt: T + 45 * MIN,
      recovered: true,
      surgeBuckets: 3,
      series: [],
      peakErrUsers: 520,
      peakBaselineErr: 120,
      peakRatio: 4.33,
      codes: { '-/1001': 477 },
      platforms: { iOS: 477 },
    };

    expect(providerPrompt(incident)).toBe(
      'Provider 111 (TVALB) had playback errors across its channels on 2026-10-10 18:00–18:45 UTC: up to 520 viewers ' +
        'with errors per 15 minutes, 4.3× the usual 120 at that time on previous days. Platforms: iOS (477). ' +
        'Error codes: -/1001 (477). Break these errors down by error code, platform, channel and ISP, and compare ' +
        'with the same time on previous days.'
    );
  });

  it('describes an ongoing service outage', () => {
    const sample = { sessions: 200, plays: 40, errEvents: 0, events: 2000 };
    const base = { baseSessions: 40, basePlays: 400, baseErrEvents: 6, baseEvents: 2000, providers: 1 };
    const incident: ActivityIncident = {
      id: 'act-1',
      kind: 'service_down',
      pid: '326',
      provider: '',
      pids: { '326': 3 },
      start: T0,
      detectedAt: T0 + 15 * MIN,
      lastSeen: T0 + 10 * MIN,
      series: [{ bucket: T0, ...sample, ...base }],
    };

    expect(activityPrompt(incident)).toContain(
      'Service down for provider 326 since 2026-09-29 17:00 UTC (still ongoing): app starts up to 5.0× the usual ' +
        'and playback starts down to 10% of the usual'
    );
  });
});
