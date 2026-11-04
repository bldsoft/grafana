import { cohortsOf, concentrated, errorKeyText } from './ViewerTables';
import { buildErrorDictionary, describeError } from './errorCodes';
import type { AffectedUserRow } from './types';

function viewer(i: number, overrides: Partial<AffectedUserRow> = {}): AffectedUserRow {
  return {
    incidentId: 'inc-1',
    userId: `AA-000-${i}`,
    platform: 'Android',
    network: 'Wi-Fi',
    isp: i % 2 ? 'ISP A' : 'ISP B',
    city: 'Tirana',
    firstErr: 0,
    lastErr: 60,
    errEvents: 3,
    topCode: '-/1001',
    watchedBeforeSec: 0,
    models: 'Xiaomi Mi Box',
    os: '11',
    appVersions: '3.13.458.458, 3.13.457.457',
    ...overrides,
  };
}

describe('viewer tables', () => {
  it('splits a problem by platform, model, build, OS, network, ISP and error', () => {
    const viewers = Array.from({ length: 10 }, (_, i) => viewer(i));
    const cohorts = cohortsOf(viewers);
    const app = cohorts.find((c) => c.key === 'app')!;
    expect(app.values).toEqual([{ value: 'Android 3.13.458.458', viewers: 10 }]);
    expect(concentrated(app, viewers.length)).toEqual({ value: 'Android 3.13.458.458', share: 1 });

    const isp = cohorts.find((c) => c.key === 'isp')!;
    expect(isp.values.map((v) => v.viewers)).toEqual([5, 5]);
    expect(concentrated(isp, viewers.length)).toBeUndefined();
    // Too few viewers to call a skew.
    expect(concentrated(app, 3)).toBeUndefined();
  });

  it('reads an error key and its meaning from the dictionary, the viewer platform first', () => {
    expect(errorKeyText('403/1001')).toBe('403 / 1001');
    expect(errorKeyText('-/-1100')).toBe('-1100');
    const dict = buildErrorDictionary([
      { platform: 'android', code: '1001', description: 'Source error' },
      { platform: 'ios', code: '1001', description: 'Playback failed' },
      { platform: '', code: '403', description: 'Forbidden' },
    ]);
    expect(describeError(dict, '403/-1001', 'iOS')).toBe('Playback failed');
    expect(describeError(dict, '403/-', 'Android')).toBe('Forbidden');
    expect(describeError(dict, '-/9999', 'Android')).toBeUndefined();
    expect(describeError(undefined, '403/1001', 'Android')).toBeUndefined();
  });
});
