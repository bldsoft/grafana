import { snapshot } from './fixtures/snapshot';
import {
  buildProblems,
  buildViewerAliases,
  buildViewerIndex,
  findViewers,
  channelsOf,
  isMajor,
  lookupRows,
  medianRecoveryMinutes,
  viewerTotals,
} from './support';
import type { ActivityIncident, CustomerSideRow, Decision } from './types';

describe('support view model', () => {
  it('lists every confirmed problem, the most recent first, with viewers and who was told', () => {
    const problems = buildProblems(snapshot());

    expect(problems.map((p) => [p.title, p.kind, p.ongoing, p.recovered, p.viewers, p.told])).toEqual([
      ['Top Channel', 'channel', false, true, 1, 1],
      ['Sport 1', 'channel', false, true, 1, 1],
    ]);
  });

  it('puts ongoing problems first', () => {
    const snap = snapshot();
    const sport = snap.incidents.find((i) => i.title === 'Sport 1')!;
    const problems = buildProblems({
      ...snap,
      incidents: snap.incidents.map((i) => (i === sport ? { ...i, closedAt: undefined, recovered: undefined } : i)),
    });

    expect(problems[0]).toMatchObject({ title: 'Sport 1', ongoing: true, recovered: undefined });
  });

  it('finds a viewer by account in any case, with their messages in time order', () => {
    const snap = snapshot();
    const index = buildViewerIndex(snap, buildProblems(snap));

    const found = findViewers(index, ' aa-549-001 ');
    expect(found.exact?.userId).toBe('AA-549-001');
    expect(found.exact?.hits).toHaveLength(1);
    expect(found.exact?.hits[0].messages.map((m) => m.kind)).toEqual(['down', 'back', 'apology']);

    const partial = findViewers(index, 'aa-');
    expect(partial.exact).toBeUndefined();
    expect(partial.total).toBe(2);
    expect(findViewers(index, 'nobody').total).toBe(0);
    expect(viewerTotals(index)).toEqual({ hit: 2, told: 2 });
  });

  it('takes the median time to recover over the recovered problems only', () => {
    const problems = buildProblems(snapshot());
    expect(medianRecoveryMinutes(problems)).toBeGreaterThan(0);
    expect(medianRecoveryMinutes(problems.map((p) => ({ ...p, recovered: false })))).toBeUndefined();
  });

  it('pins ongoing problems wider than one channel above channel failures', () => {
    const snap = snapshot();
    const sport = snap.incidents.find((i) => i.title === 'Sport 1')!;
    const service: ActivityIncident = {
      id: 'act-1',
      kind: 'service_down',
      pid: '222',
      provider: 'NimiTV',
      pids: { '222': 3 },
      start: sport.start - 3600,
      detectedAt: sport.start - 3000,
      lastSeen: sport.start,
      series: [],
    };
    const problems = buildProblems({
      ...snap,
      activity: [service],
      incidents: snap.incidents.map((i) => (i === sport ? { ...i, closedAt: undefined, recovered: undefined } : i)),
    });
    expect(problems.map((p) => [p.kind, p.ongoing])).toEqual([
      ['service_down', true],
      ['channel', true],
      ['channel', false],
    ]);
    expect(problems.filter(isMajor).map((p) => p.id)).toEqual(['act-1']);
  });

  it('finds a viewer by the IP, serial or device id of their device', () => {
    const snap = snapshot();
    const id = snap.incidents.find((i) => i.title === 'Sport 1')!.id;
    const rows = snap
      .affected(id)
      .map((r) => ({ ...r, ips: '10.1.2.3, 10.1.2.4', serials: 'SN-777', deviceIds: 'dev-9' }));
    const problems = buildProblems({ ...snap, affected: (x) => (x === id ? rows : snap.affected(x)) });
    const index = buildViewerIndex({ ...snap, affected: (x) => (x === id ? rows : snap.affected(x)) }, problems);
    const aliases = buildViewerAliases(index);

    expect(findViewers(index, '10.1.2.4', aliases).exact?.userId).toBe('AA-549-001');
    expect(findViewers(index, 'sn-777', aliases).exact?.userId).toBe('AA-549-001');
    expect(findViewers(index, 'DEV-9', aliases).exact?.userId).toBe('AA-549-001');
    expect(findViewers(index, '10.9.9.9', aliases).total).toBe(0);
  });

  it('puts problems and errors only on their side in one list, each with its message', () => {
    const snap = snapshot();
    const day = (first: number, last: number): CustomerSideRow => ({
      pid: '222',
      provider: 'NimiTV',
      userId: 'AA-549-001',
      platform: 'Android',
      network: 'Wi-Fi',
      isp: 'Spectrum',
      city: 'Smyrna',
      channels: 4,
      minutes: 5,
      errEvents: 9,
      firstMinute: first,
      lastMinute: last,
      topCode: '1002',
      ips: '35.151.157.73',
      channelTitles: 'News | Sport 2',
    });
    const diagnosis = (at: number): Decision => ({
      kind: 'diagnosis',
      at,
      userId: 'AA-549-001',
      pid: '222',
      provider: 'NimiTV',
      cid: '',
      title: '4 channels',
      reason: '',
      platform: 'Android',
    });
    const early = snap.from - 86400;
    const input = {
      ...snap,
      customer: [day(early, early + 240), day(snap.to - 600, snap.to - 300)],
      // The second message has no day left in the run (an older chunk of live).
      decisions: [...snap.decisions, diagnosis(early + 300), diagnosis(early - 86400)],
    };
    const record = findViewers(buildViewerIndex(input, buildProblems(input)), 'AA-549-001').exact!;
    const rows = lookupRows(record);

    expect(
      rows.map((r) => [r.problem?.title ?? 'their side', r.facts?.ips, r.facts?.topCode, r.messages.length])
    ).toEqual([
      ['their side', '35.151.157.73', '1002', 0],
      ['Sport 1', undefined, '403/1001', 3],
      ['their side', '35.151.157.73', '1002', 1],
      ['their side', undefined, undefined, 1],
    ]);
    expect(record.customer[0].lastMinute).toBe(snap.to - 300);
  });

  it('counts the channels of a wide problem by its viewers', () => {
    expect(
      channelsOf([{ channelTitles: 'A, with comma | B' }, { channelTitles: 'B' }, {}, { channelTitles: 'C | B' }])
    ).toEqual([
      { title: 'B', viewers: 3 },
      { title: 'A, with comma', viewers: 1 },
      { title: 'C', viewers: 1 },
    ]);
  });
});
