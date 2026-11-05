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
      { err_platform: 'android', err_code: '1001', meaning: 'Source error' },
      { err_platform: 'ios', err_code: '1001', meaning: 'Playback failed' },
      { err_platform: '', err_code: '403', meaning: 'Forbidden' },
    ]);
    expect(describeError(dict, '403/-1001', 'iOS')).toBe('Playback failed');
    expect(describeError(dict, '403/-', 'Android')).toBe('Forbidden');
    expect(describeError(dict, '-/9999', 'Android')).toBeUndefined();
    expect(describeError(undefined, '403/1001', 'Android')).toBeUndefined();
  });

  it("does not borrow another platform's words for a code that means different things", () => {
    const dict = buildErrorDictionary([
      { err_platform: 'android', err_code: '4001', meaning: 'Decoder initialization failure' },
      { err_platform: 'smarttv', err_code: '4001', meaning: 'Invalid DASH manifest XML' },
      { err_platform: 'ios', err_code: '12660', meaning: 'HTTP 403: Forbidden' },
      { err_platform: 'tvos', err_code: '12660', meaning: 'HTTP 403: Forbidden' },
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
    const sql = errorDictionarySql();
    expect(sql).toContain('FROM stat.error_dictionary_dict');
    // An alias equal to a column name is substituted into WHERE (ILLEGAL_AGGREGATION on prod).
    const aliases = [...sql.matchAll(/\bAS (\w+)/g)].map((m) => m[1]);
    expect(aliases).toEqual(['err_platform', 'err_code', 'meaning']);
    for (const column of ['platform', 'error_code', 'description']) {
      expect(aliases).not.toContain(column);
    }
    expect(errorDictionarySql('stat.error_dictionary_dst')).toContain('FROM stat.error_dictionary_dst');
  });

  it('puts the error meaning on the error cohort', () => {
    const dict = buildErrorDictionary([{ err_platform: 'android', err_code: '1001', meaning: 'Source error' }]);
    const error = cohortsOf([viewer(1)], dict).find((c) => c.key === 'error')!;
    expect(error.values[0].value).toBe('1001 — Source error');
  });
});
