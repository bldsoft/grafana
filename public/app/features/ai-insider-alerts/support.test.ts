import { snapshot } from './fixtures/snapshot';
import { buildProblems, buildViewerIndex, findViewers, medianRecoveryMinutes, viewerTotals } from './support';

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
});
