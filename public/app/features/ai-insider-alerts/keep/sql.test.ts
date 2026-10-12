import { isSafeBridgeSql } from 'app/features/dashboard-scene/ai-panel/datasourceQuery';

import { CODE, IS_ERR, IS_PAYWALL, VERSION_GATE } from '../sql';

import { accountDaysSql, estimateSql } from './sql';
import type { AccountDayRow, DayLevel } from './types';

const D = Date.UTC(2026, 9, 5) / 1000;
const DAY = 86400;

/**
 * The level each row field comes with. A Record over every key of
 * AccountDayRow: a field added to the contract without a column fails to
 * compile here.
 */
const LEVEL_OF: Record<keyof AccountDayRow, DayLevel> = {
  pid: 'light',
  account: 'light',
  events: 'light',
  legacy_events: 'light',
  gated_plays: 'light',
  ungated_plays: 'light',
  watch_all_min: 'light',
  expiry_seen: 'light',
  expired_events: 'light',
  inactive_attempts: 'light',
  expired_reports: 'light',
  plan: 'light',
  first_ts: 'light',
  last_ts: 'light',
  platforms: 'light',
  app_starts: 'full',
  sessions: 'full',
  play_sessions: 'full',
  opens: 'full',
  watch_min: 'full',
  live_min: 'full',
  ondemand_min: 'full',
  catchup_min: 'full',
  distinct_content: 'full',
  seeds: 'full',
  playbacks: 'full',
  failed_playbacks: 'full',
  buffering_stops: 'full',
  top_err_code: 'full',
  premium_attempts: 'full',
  premium_paid_content: 'full',
  paywall_title: 'full',
  paywall_codes: 'full',
  search_sessions: 'full',
  failed_search_sessions: 'full',
  fav_added: 'full',
  fav_removed: 'full',
  org: 'full',
  sub_id: 'full',
  org_id: 'full',
  hours: 'full',
  tz_offset_h: 'full',
};

const fieldsOf = (level: DayLevel) =>
  Object.entries(LEVEL_OF)
    .filter(([, l]) => level === 'full' || l === 'light')
    .map(([name]) => name)
    .sort();

/** `alias -> expression` of the lines between `head` and `tail` (one `<expr> AS <alias>` per line). */
function aliases(sql: string, head: string, tail: string): Map<string, string> {
  const body = sql.slice(sql.indexOf(head) + head.length, sql.indexOf(tail));
  const out = new Map<string, string>();
  for (const line of body.split('\n')) {
    const m = /^\s*(.+) AS (\w+),?$/.exec(line);
    if (m) {
      out.set(m[2], m[1]);
    }
  }
  return out;
}
const selected = (sql: string) => aliases(sql, '\nSELECT\n', '\nFROM ');
const withAliases = (sql: string) => aliases(sql, 'WITH\n', '\nSELECT\n');

const levels: DayLevel[] = ['full', 'light'];

describe('keep account-day SQL', () => {
  it('passes the client-side read-only gate at both levels, without a statement separator', () => {
    for (const level of levels) {
      const sql = accountDaysSql(D, D + DAY, ['111', '222'], level);
      expect(isSafeBridgeSql(sql)).toBe(true);
      expect(sql).not.toContain(';');
      expect(isSafeBridgeSql(accountDaysSql(D, D + DAY, null, level))).toBe(true);
    }
  });

  it('carries the mandatory clauses and the keep SETTINGS footer', () => {
    for (const level of levels) {
      const sql = accountDaysSql(D, D + DAY, ['111'], level);
      expect(sql).toContain(`event_timestamp >= toDateTime(${D}) AND event_timestamp < toDateTime(${D + DAY})`);
      expect(sql).toContain("content_user_account_number != '' AND content_user_account_number NOT LIKE '%-GUEST'");
      expect(sql).toContain("event_type NOT IN ('stream_info', 'cdn_info')");
      expect(sql).toContain('FROM stat.info_v1_7_dst');
      expect(sql).toContain('GROUP BY pid, account');
      expect(sql).toContain('max_execution_time = 45');
      expect(sql).toContain('max_bytes_to_read = 20000000000');
      expect(sql).toContain("timeout_overflow_mode = 'throw'");
      expect(sql).toContain('max_result_rows = 400000');
      expect(sql).toContain("result_overflow_mode = 'throw'");
      expect(sql.trim().endsWith("log_comment = 'ai-insider:keep'")).toBe(true);
      expect(sql.match(/SETTINGS max_execution_time/g)).toHaveLength(1);
    }
  });

  it('keeps the version gate out of WHERE: legacy builds still count as activity', () => {
    for (const level of levels) {
      const sql = accountDaysSql(D, D + DAY, ['111'], level);
      expect(withAliases(sql).get('gated')).toBe(`(${VERSION_GATE})`);
      expect(sql.slice(sql.indexOf('\nWHERE '))).not.toContain('analytics_version');
    }
  });

  it('selects exactly the AccountDayRow columns of its level, light a subset of full', () => {
    const full = [...selected(accountDaysSql(D, D + DAY, null, 'full')).keys()].sort();
    const light = [...selected(accountDaysSql(D, D + DAY, null, 'light')).keys()].sort();
    expect(full).toEqual(fieldsOf('full'));
    expect(light).toEqual(fieldsOf('light'));
    expect(light.every((c) => full.includes(c))).toBe(true);
  });

  it('returns complex values as JSON text, times as epoch numbers and integer topK weights', () => {
    const cols = selected(accountDaysSql(D, D + DAY, null, 'full'));
    for (const name of ['expiry_seen', 'expired_reports', 'seeds', 'paywall_codes', 'hours']) {
      expect(cols.get(name)).toMatch(/^toJSONString\(/);
    }
    expect(cols.get('first_ts')).toBe('toUnixTimestamp(min(event_timestamp))');
    expect(cols.get('last_ts')).toBe('toUnixTimestamp(max(event_timestamp))');
    expect(cols.get('seeds')).toContain("topKWeightedIf(8, 10, 'counts')(");
    expect(cols.get('seeds')).toContain('toUInt64(round(wa))');
    expect(withAliases(accountDaysSql(D, D + DAY, null, 'full')).get('hour_map')).toContain('[toUInt64(round(wa))]');
    // No floating weight anywhere: a Float64 weight fails the whole day.
    expect(accountDaysSql(D, D + DAY, null, 'full')).not.toMatch(/topKWeighted\w*\([^)]*\)\([^,]+, (w|wa)\b/);
  });

  it('defines the WITH aliases the rules rely on', () => {
    const light = withAliases(accountDaysSql(D, D + DAY, null, 'light'));
    const full = withAliases(accountDaysSql(D, D + DAY, null, 'full'));
    for (const name of ['gated', 'w', 'ctype', 'wa', 'is_play', 'paywall', 'inactive', 'attempt_key']) {
      expect(light.has(name)).toBe(true);
    }
    for (const name of [
      'is_watch_dash',
      'off',
      'premium',
      'search_sids',
      'hit_sids',
      'play_keys',
      'failed_keys',
      'refused_keys',
    ]) {
      expect(full.has(name)).toBe(true);
      expect(light.has(name)).toBe(false);
    }
    // Watch time for trends counts every stop with time, buffering and errors included.
    expect(full.get('wa')).not.toContain('streamBuffering');
    expect(full.get('is_watch_dash')).toContain("event_parameter8 NOT IN ('streamBuffering', 'streamError')");
  });

  it('never selects the search text: search rows only give their session id', () => {
    const sql = accountDaysSql(D, D + DAY, null, 'full');
    const withs = withAliases(sql);
    // The only use of search rows: a session-id set.
    expect(sql.match(/event_type = 'search'/g)).toHaveLength(1);
    expect(withs.get('search_sids')).toMatch(
      /^groupUniqArrayIf\(64\)\(event_parameter9, gated AND event_type = 'search' /
    );
    // Whatever reads the content id (slot 1) is limited to playback rows.
    expect(withs.get('is_play')).toContain("event_type = 'play_start'");
    expect(withs.get('wa')).toMatch(/^if\(event_type = 'play_stop' AND /);
    expect(withs.get('paywall')).toContain("event_type IN ('play_start', 'play_stop')");
    for (const [alias, expr] of selected(sql)) {
      if (/\bevent_parameter1\b|\battempt_key\b/.test(expr)) {
        expect([alias, expr]).toEqual([alias, expect.stringMatching(/is_play|wa > 0|inactive|premium|play_start/)]);
      }
    }
    // Attempt-key sets (key = session + content id) are limited to playback rows too.
    for (const [alias, expr] of withs) {
      if (alias !== 'attempt_key' && /\battempt_key\b/.test(expr)) {
        expect([alias, expr]).toEqual([alias, expect.stringMatching(/is_play|paywall|play_start/)]);
      }
    }
    expect(sql).not.toMatch(/\b(any|anyLast|groupArray|topK)\w*\((\d+\))?\(?event_parameter1\b/);
  });

  it('reads nothing for an empty scope and every provider for null', () => {
    for (const level of levels) {
      expect(accountDaysSql(D, D + DAY, [], level)).toContain('AND 0');
      expect(accountDaysSql(D, D + DAY, null, level)).not.toContain('content_provider_id IN');
    }
  });

  it('inlines only well-formed provider ids', () => {
    const sql = accountDaysSql(D, D + DAY, ["111'; DROP TABLE x", '222', "' OR 1=1 --"], 'full');
    expect(sql).toContain("content_provider_id IN ('222')");
    expect(sql).not.toContain('DROP');
    expect(sql).not.toContain('OR 1=1');
    expect(isSafeBridgeSql(sql)).toBe(true);
  });

  it('reads half a day, and refuses empty or longer-than-a-day windows', () => {
    const first = accountDaysSql(D, D + DAY / 2, ['111'], 'full');
    const second = accountDaysSql(D + DAY / 2, D + DAY, ['111'], 'full');
    expect(first).toContain(`event_timestamp >= toDateTime(${D}) AND event_timestamp < toDateTime(${D + DAY / 2})`);
    expect(second).toContain(
      `event_timestamp >= toDateTime(${D + DAY / 2}) AND event_timestamp < toDateTime(${D + DAY})`
    );
    expect(() => accountDaysSql(D, D, ['111'], 'full')).toThrow();
    expect(() => accountDaysSql(D, D + 2 * DAY, ['111'], 'light')).toThrow();
    expect(() => accountDaysSql(NaN, D, ['111'], 'light')).toThrow();
    expect(() => accountDaysSql(D, D + DAY, ['111'], 'heavy' as DayLevel)).toThrow();
  });
});

describe('keep estimate SQL', () => {
  it('counts accounts per provider from the daily aggregates of the day', () => {
    const sql = estimateSql(D, ['111', '222']);
    expect(isSafeBridgeSql(sql)).toBe(true);
    expect(sql).not.toContain(';');
    expect(sql).toContain('uniqCombinedMerge(unique_accounts_state) AS accounts');
    expect(sql).toContain('content_provider_id AS pid');
    expect(sql).toContain('FROM stat.info_v1_7_daily_aggregates_dst');
    expect(sql).toContain('GROUP BY pid');
    // One stored day whatever the server's time zone: the bucket nearest to the UTC midnight.
    expect(sql).toContain(`day >= toDateTime(${D - DAY / 2}) AND day < toDateTime(${D + DAY / 2})`);
    expect(sql).toContain("content_provider_id IN ('111', '222')");
    expect(sql.trim().endsWith("log_comment = 'ai-insider:keep'")).toBe(true);
  });

  it('fails closed on an empty scope and drops malformed ids', () => {
    expect(estimateSql(D, [])).toContain('AND 0');
    expect(estimateSql(D, null)).not.toContain('content_provider_id IN');
    expect(estimateSql(D, ["1'; DROP", '111'])).toContain("content_provider_id IN ('111')");
  });
});

/** Every column of stat.info_v1_7_dst (skills/clickhouse-api-v3, schema.md). */
const TABLE_COLUMNS = [
  'event_id',
  'event_timestamp',
  '__inserted_time_created_event',
  'analytics_version',
  'config_accountCode',
  'app_name',
  'app_id',
  'app_releaseVersion',
  'device_type',
  'device_name',
  'device_model',
  'device_OsVersion',
  'device_id',
  'device_mac_address',
  'device_serial_number',
  'network_ip',
  'network_isp',
  'network_type',
  'network_location',
  'City',
  'Subdivision',
  'Country',
  'Continent',
  'ISP',
  'content_provider_id',
  'content_user_subscriber_id',
  'content_user_account_number',
  'content_user_profile_id',
  'content_user_profile_name',
  'organisation_id',
  'organisation_name',
  'subscription_id',
  'subscription_name',
  'subscription_expiration_time',
  'event_type',
  ...Array.from({ length: 20 }, (_, i) => `event_parameter${i + 1}`),
];

describe('keep SQL aliases', () => {
  it('never names an alias like a column: ClickHouse would substitute it into its own aggregate', () => {
    expect(new Set(TABLE_COLUMNS).size).toBe(55);
    const statements = [...levels.map((level) => accountDaysSql(D, D + DAY, ['111'], level)), estimateSql(D, ['111'])];
    const all = new Set<string>();
    for (const sql of statements) {
      const castTypes = new Set([...sql.matchAll(/CAST\(\w+ AS (\w+)\)/g)].map((m) => m[1]));
      for (const [, name] of sql.matchAll(/\bAS (\w+)/g)) {
        if (!castTypes.has(name)) {
          all.add(name);
        }
      }
    }
    expect([...all].filter((name) => TABLE_COLUMNS.includes(name))).toEqual([]);
    // ...and that covered every WITH and SELECT alias of both levels.
    for (const name of [...Object.keys(LEVEL_OF), ...withAliases(accountDaysSql(D, D + DAY, null, 'full')).keys()]) {
      expect(all.has(name)).toBe(true);
    }
  });
});

type EventRow = Record<string, string>;
/** Named WITH aliases a condition may use as a boolean: a fixed value or their own SQL. */
type BoolAliases = Record<string, boolean | string>;

/**
 * Evaluates a boolean SQL condition on one event (as ../sql.test.ts does), so
 * the tests check what the conditions mean rather than how they are spelled.
 * Grammar: OR / AND / NOT, parentheses, `col = 'v'`, `col != 'v'`,
 * `col [NOT] IN ('a', ...)`, `replaceAll(col, 'a', 'b')` and boolean aliases.
 */
function evalCondition(sql: string, row: EventRow, bools: BoolAliases = {}): boolean {
  const tokens = sql.match(/'(?:[^']|'')*'|!=|[=(),]|[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  let i = 0;
  const peek = (word?: string) => (word === undefined ? tokens[i] : tokens[i]?.toUpperCase() === word);
  const take = (word?: string) => {
    if (word !== undefined && !peek(word)) {
      throw new Error(`Expected ${word} at ${tokens.slice(i, i + 5).join(' ')}`);
    }
    return tokens[i++];
  };
  const literal = (t: string) => t.slice(1, -1).replace(/''/g, "'");
  const value = (): string => {
    const t = take();
    if (t === 'replaceAll') {
      take('(');
      const subject = value();
      take(',');
      const from = value();
      take(',');
      const to = value();
      take(')');
      return subject.split(from).join(to);
    }
    return t.startsWith("'") ? literal(t) : (row[t] ?? '');
  };
  const or = (): boolean => {
    let v = and();
    while (peek('OR')) {
      take();
      v = and() || v;
    }
    return v;
  };
  const and = (): boolean => {
    let v = not();
    while (peek('AND')) {
      take();
      v = not() && v;
    }
    return v;
  };
  const not = (): boolean => {
    if (peek('NOT')) {
      take();
      return !not();
    }
    return comparison();
  };
  const comparison = (): boolean => {
    if (peek('(')) {
      take();
      const v = or();
      take(')');
      return v;
    }
    const name = tokens[i];
    if (name in bools && !['=', '!=', 'IN', 'NOT'].includes(tokens[i + 1]?.toUpperCase())) {
      take();
      const alias = bools[name];
      return typeof alias === 'boolean' ? alias : evalCondition(alias, row, bools);
    }
    const left = value();
    if (peek('=') || peek('!=')) {
      const op = take();
      const right = value();
      return op === '=' ? left === right : left !== right;
    }
    const negate = peek('NOT');
    if (negate) {
      take();
    }
    take('IN');
    take('(');
    const list = [value()];
    while (peek(',')) {
      take();
      list.push(value());
    }
    take(')');
    return list.includes(left) !== negate;
  };
  const result = or();
  if (i !== tokens.length) {
    throw new Error(`Unparsed SQL: ${tokens.slice(i).join(' ')}`);
  }
  return result;
}

const start = (extra: EventRow = {}): EventRow => ({
  event_type: 'play_start',
  event_parameter2: 'tv',
  event_parameter8: 'userAction',
  event_parameter10: '',
  event_parameter11: '',
  ...extra,
});
const stop = (extra: EventRow = {}): EventRow => ({ ...start(), event_type: 'play_stop', ...extra });

describe('keep failed playbacks', () => {
  const sql = accountDaysSql(D, D + DAY, null, 'full');
  const withs = withAliases(sql);
  const cols = selected(sql);
  /** The condition of an attempt-key set `groupUniqArrayIf(cityHash64(attempt_key), <condition>)`. */
  const keySet = (alias: string) => {
    const m = /^groupUniqArrayIf\(cityHash64\(attempt_key\), (.+)\)$/.exec(withs.get(alias) ?? '');
    if (!m) {
      throw new Error(`${alias} is not an attempt-key set`);
    }
    return m[1];
  };
  const bools = (gated: boolean): BoolAliases => ({
    gated,
    paywall: withs.get('paywall')!,
    is_play: withs.get('is_play')!,
  });
  const inSet = (alias: string, row: EventRow, gated: boolean) => evalCondition(keySet(alias), row, bools(gated));
  const isFailedRow = (row: EventRow, gated = true) => inSet('failed_keys', row, gated);
  const isPlayRow = (row: EventRow, gated = true) => inSet('play_keys', row, gated);
  const isRefusedRow = (row: EventRow, gated = true) => inSet('refused_keys', row, gated);
  /** failed_playbacks of one attempt: the rows sharing one attempt key. */
  const failed = (rows: EventRow[], gated = true) =>
    rows.some((r) => isFailedRow(r, gated)) &&
    rows.some((r) => isPlayRow(r, gated)) &&
    !rows.some((r) => isRefusedRow(r, gated));

  it('counts failed attempts among the playbacks only, so the share never exceeds 1', () => {
    expect(cols.get('playbacks')).toBe('length(play_keys)');
    expect(cols.get('failed_playbacks')).toBe(
      'length(arrayFilter(k -> NOT has(refused_keys, k), arrayIntersect(failed_keys, play_keys)))'
    );
    expect(keySet('play_keys')).toBe('gated AND is_play');
    expect(keySet('refused_keys')).toBe('paywall');
    expect(keySet('failed_keys')).toContain(`(${IS_ERR})`);
    expect(withs.get('paywall')).toBe(`(${IS_PAYWALL})`);
  });

  it('counts a plain stream error stop and an error start of a real playback', () => {
    expect(isFailedRow(stop({ event_parameter8: 'streamError' }))).toBe(true);
    expect(failed([start(), stop({ event_parameter8: 'streamError' })])).toBe(true);
    expect(failed([start({ event_parameter10: '500' })])).toBe(true);
    expect(failed([start({ event_parameter11: 'AE403' })])).toBe(true);
    expect(failed([start(), stop({ event_parameter8: 'userAction' })])).toBe(false);
    expect(failed([start({ event_parameter10: '0' })])).toBe(false);
    // Builds without the analytics contract report no codes.
    expect(failed([start(), stop({ event_parameter8: 'streamError' })], false)).toBe(false);
  });

  it('does not count a paywall refusal, also when its stop says streamError', () => {
    const codes: EventRow[] = [
      { event_parameter10: '402' },
      { event_parameter11: 'AE402' },
      { event_parameter11: '-103' },
    ];
    for (const code of codes) {
      const refusedStop = stop({ event_parameter8: 'streamError', ...code });
      expect(isFailedRow(refusedStop)).toBe(false);
      expect(failed([start(code), refusedStop])).toBe(false);
      // Only the start carries the code: the whole attempt is still a refusal.
      expect(failed([start(code), stop({ event_parameter8: 'streamError' })])).toBe(false);
    }
    expect(
      failed([start({ event_parameter10: 'subsctiprionInActive' }), stop({ event_parameter8: 'streamError' })])
    ).toBe(false);
  });

  it('does not count an error of the home-screen preview', () => {
    const previewError = start({ event_parameter8: 'autoPreview', event_parameter10: '500' });
    expect(isFailedRow(previewError)).toBe(false);
    expect(failed([previewError])).toBe(false);
    // The viewer then opened it and it played fine.
    expect(failed([previewError, start()])).toBe(false);
    // A preview that failed on its stop is not one of the playbacks.
    expect(failed([start({ event_parameter8: 'autoPreview' }), stop({ event_parameter8: 'streamError' })])).toBe(false);
  });

  it('does not count a trailer that failed', () => {
    const trailerStop = stop({ event_parameter2: 'trailer', event_parameter8: 'streamError' });
    expect(isFailedRow(trailerStop)).toBe(false);
    expect(isFailedRow(start({ event_parameter2: 'trailer', event_parameter10: '500' }))).toBe(false);
    // The trailer shares the title's content id, so its key can equal a real playback's.
    expect(failed([start({ event_parameter2: 'vod' }), trailerStop])).toBe(false);
  });
});

describe('keep paywall codes and expired reports', () => {
  const sql = accountDaysSql(D, D + DAY, null, 'full');
  const cols = selected(sql);
  const withs = withAliases(sql);

  it('counts refusal rows per platform and code, with the candidate forms', () => {
    const m =
      /^toJSONString\(sumMapIf\(\[concat\(CAST\(device_type AS String\), '\|', (.+)\)\], \[toUInt32\(1\)\], (.+)\)\)$/.exec(
        cols.get('paywall_codes') ?? ''
      );
    expect(m).not.toBeNull();
    const [, code, condition] = m!;
    // Keyed by the row's own platform, not the account-day's platform list.
    expect(code).toBe(CODE);
    const counted = (row: EventRow) => evalCondition(condition, row, { paywall: withs.get('paywall')! });
    for (const row of [
      start({ event_parameter10: '402' }),
      start({ event_parameter10: 'subsctiprionInActive' }),
      start({ event_parameter11: 'AE402' }),
      start({ event_parameter11: '-103' }),
      start({ event_parameter11: '103' }),
      start({ event_parameter11: '402' }),
      start({ event_parameter11: 'AE403' }),
      stop({ event_parameter10: '402' }),
    ]) {
      expect([row, counted(row)]).toEqual([row, true]);
    }
    for (const row of [
      start(),
      start({ event_parameter10: '500' }),
      start({ event_parameter11: '-1100' }),
      stop({ event_parameter8: 'streamError' }),
      { ...start({ event_parameter10: '402' }), event_type: 'player_open' },
    ]) {
      expect([row, counted(row)]).toEqual([row, false]);
    }
  });

  it('names each subscription end that had passed, with the first event that still reported it', () => {
    const condition = /^countIf\((.+)\)$/.exec(cols.get('expired_events') ?? '')![1];
    expect(condition).toContain('subscription_expiration_time > toDateTime(0)');
    expect(condition).toContain('toYear(subscription_expiration_time) < 2100');
    expect(condition).toContain('subscription_expiration_time < event_timestamp');
    expect(condition).toContain("event_type NOT IN ('session_start', 'session_end')");
    const expected = `toJSONString(minMapIf([toUInt32(toUnixTimestamp(subscription_expiration_time))], [toUInt32(toUnixTimestamp(event_timestamp))], ${condition}))`;
    for (const level of levels) {
      expect(selected(accountDaysSql(D, D + DAY, null, level)).get('expired_reports')).toBe(expected);
    }
  });
});
