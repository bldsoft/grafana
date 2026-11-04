import { cohortsOf, concentrated } from './ViewerTables';
import { buildErrorDictionary, describeCodes, describeError, errorDictionarySql, errorKeyText } from './errorCodes';
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

  it("does not borrow another platform's words for a code that means different things", () => {
    const dict = buildErrorDictionary([
      { platform: 'android', code: '4001', description: 'Decoder initialization failure' },
      { platform: 'smarttv', code: '4001', description: 'Invalid DASH manifest XML' },
      { platform: 'ios', code: '12660', description: 'HTTP 403: Forbidden' },
      { platform: 'tvos', code: '12660', description: 'HTTP 403: Forbidden' },
    ]);
    expect(describeError(dict, '-/4001', 'SmartTV')).toBe('Invalid DASH manifest XML');
    expect(describeError(dict, '-/4001', 'Roku')).toBeUndefined();
    // Every platform says the same: fine for any viewer.
    expect(describeError(dict, '403/-12660', 'web')).toBe('HTTP 403: Forbidden');
    expect(describeCodes(dict, { '-/4001': 3, '403/-12660': 9 }, { Android: 10, SmartTV: 2 })).toEqual([
      { key: '403/-12660', count: 9, description: 'HTTP 403: Forbidden' },
      { key: '-/4001', count: 3, description: 'Decoder initialization failure' },
    ]);
  });

  it('reads the ClickHouse dictionary, the table only as a fallback', () => {
    expect(errorDictionarySql()).toContain('FROM stat.error_dictionary_dict');
    expect(errorDictionarySql('stat.error_dictionary_dst')).toContain('FROM stat.error_dictionary_dst');
  });

  it('puts the error meaning on the error cohort', () => {
    const dict = buildErrorDictionary([{ platform: 'android', code: '1001', description: 'Source error' }]);
    const error = cohortsOf([viewer(1)], dict).find((c) => c.key === 'error')!;
    expect(error.values[0].value).toBe('1001 — Source error');
  });
});
