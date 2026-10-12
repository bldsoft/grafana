import { isSafeBridgeSql } from 'app/features/dashboard-scene/ai-panel/datasourceQuery';

import { effectiveScope, parseProviderScope } from './scope';
import {
  activitySql,
  affectedUsersSql,
  badMinutesSql,
  channelHealthSql,
  channelMinutesSql,
  customerSideSql,
  errorVolumeSql,
  IS_ERR,
  IS_PAYWALL,
  providerNamesSql,
  settingsClause,
  userErrorsSql,
} from './sql';
import { DEFAULT_RULES } from './types';

const FROM = Date.UTC(2026, 8, 29) / 1000;
const TO = FROM + 3600;

const statements = () => [
  badMinutesSql(FROM, TO, ['111', '222'], DEFAULT_RULES),
  affectedUsersSql([{ id: 'inc-1', pid: '222', cid: '20002549', start: FROM, end: TO }], null),
  customerSideSql(FROM, TO, null, DEFAULT_RULES),
  channelHealthSql(FROM, TO, ['111']),
  channelMinutesSql(FROM, TO, null, [{ pid: '222', cid: '20002549' }]),
  errorVolumeSql(FROM, TO, null),
  userErrorsSql(FROM, TO, ['222']),
];

describe('alerts SQL', () => {
  it('passes the client-side read-only gate', () => {
    for (const sql of [...statements(), providerNamesSql(['111'])]) {
      expect(isSafeBridgeSql(sql)).toBe(true);
    }
  });

  it('carries the mandatory clauses of the analytics skill in every statement', () => {
    for (const sql of statements()) {
      expect(sql).toMatch(/event_timestamp >= toDateTime\(\d+\) AND event_timestamp < toDateTime\(\d+\)/);
      expect(sql).toContain("analytics_version != ''");
      expect(sql).toContain('(3, 34, 2)');
      expect(sql).toContain("event_type IN ('player_open', 'play_start', 'play_stop')");
      expect(sql).toContain("device_type != 'web', device_serial_number, network_ip");
      expect(sql.trim().endsWith("log_comment = 'ai-insider:alerts'")).toBe(true);
      expect(sql.match(/SETTINGS max_execution_time/g)).toHaveLength(1);
    }
  });

  it('inlines only well-formed provider ids and reads nothing for an empty scope', () => {
    const sql = badMinutesSql(FROM, TO, ["111'; DROP", '222'], DEFAULT_RULES);
    expect(sql).toContain("content_provider_id IN ('222')");
    expect(sql).not.toContain('DROP');
    expect(errorVolumeSql(FROM, TO, [])).toContain('AND 0');
    expect(errorVolumeSql(FROM, TO, null)).not.toContain('content_provider_id IN');
  });

  it('counts app activity from every client, gating only the error count', () => {
    const sql = activitySql(FROM, TO, ['222']);
    expect(isSafeBridgeSql(sql)).toBe(true);
    expect(sql).toMatch(/event_timestamp >= toDateTime\(\d+\) AND event_timestamp < toDateTime\(\d+\)/);
    expect(sql).toContain("content_provider_id IN ('222')");
    expect(sql).toContain("countIf(event_type = 'session_start') AS sessions");
    // The version gate sits on the error count only, never in WHERE.
    expect(sql.split('WHERE')[1]).not.toContain('analytics_version');
    expect(sql).toMatch(/countIf\(\(.+\) AND analytics_version != ''/);
    expect(sql.trim().endsWith("log_comment = 'ai-insider:alerts'")).toBe(true);
    expect(activitySql(FROM, TO, [])).toContain('AND 0');
  });

  it('rejects malformed incident keys instead of inlining them', () => {
    expect(() => affectedUsersSql([{ id: 'x', pid: '222', cid: "1' OR 1", start: FROM, end: TO }], null)).toThrow();
  });
});

describe('SETTINGS footer', () => {
  it('is the Alerts footer, byte for byte, without options', () => {
    expect(settingsClause('ai-insider:alerts')).toBe(`SETTINGS max_execution_time = 60,
         max_memory_usage = 12000000000,
         max_bytes_to_read = 100000000000,
         read_overflow_mode = 'throw',
         log_comment = 'ai-insider:alerts'`);
  });

  it('adds the time and result-size limits a caller asks for', () => {
    expect(
      settingsClause('ai-insider:keep', { maxExecutionSec: 45, maxBytesToRead: 20_000_000_000, maxResultRows: 400_000 })
    ).toBe(`SETTINGS max_execution_time = 45,
         max_memory_usage = 12000000000,
         max_bytes_to_read = 20000000000,
         read_overflow_mode = 'throw',
         timeout_overflow_mode = 'throw',
         max_result_rows = 400000,
         result_overflow_mode = 'throw',
         log_comment = 'ai-insider:keep'`);
  });

  it('refuses a log comment that could break out of its quotes', () => {
    expect(() => settingsClause("x', max_execution_time = 0, log_comment = 'y")).toThrow();
    expect(() => settingsClause('')).toThrow();
  });
});

type EventRow = Record<string, string>;

/**
 * Evaluates the boolean SQL of the error definitions on one event, so the
 * tests check what the conditions mean rather than how they are spelled.
 * Grammar: OR / AND / NOT, parentheses, `col = 'v'`, `col != 'v'`,
 * `col [NOT] IN ('a', ...)` and `match(col, 're')`.
 */
function evalCondition(sql: string, row: EventRow): boolean {
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
    if (tokens[i] === 'match') {
      take();
      take('(');
      const subject = value();
      take(',');
      const re = new RegExp(value());
      take(')');
      return re.test(subject);
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

/** The expression a statement selects under `alias`. */
function selectedExpr(sql: string, alias: string): string {
  const m = new RegExp(`\\n\\s*(.+) AS ${alias},?\\n`).exec(sql);
  if (!m) {
    throw new Error(`No ${alias} in the statement`);
  }
  return m[1];
}

const play = (ep10: string, ep11 = '', extra: EventRow = {}): EventRow => ({
  event_type: 'play_start',
  event_parameter8: '',
  event_parameter10: ep10,
  event_parameter11: ep11,
  ...extra,
});

describe('paywall is not a playback error', () => {
  const isErr = (row: EventRow) => evalCondition(IS_ERR, row);
  const minuteSql = badMinutesSql(FROM, TO, ['111'], DEFAULT_RULES);
  const isSrv = (row: EventRow) => evalCondition(selectedExpr(minuteSql, 'is_srv'), row);

  it('recognises every paywall code on playback events only', () => {
    for (const row of [
      play('subsctiprionInActive'),
      play('', 'subsctiprionInActive'),
      play('402'),
      play('', 'AE402'),
      play('', '-103'),
      { ...play('402'), event_type: 'play_stop' },
    ]) {
      expect(evalCondition(IS_PAYWALL, row)).toBe(true);
    }
    expect(evalCondition(IS_PAYWALL, { ...play('402'), event_type: 'player_open' })).toBe(false);
    expect(evalCondition(IS_PAYWALL, play('', 'AE403'))).toBe(false);
  });

  it('does not count a refused playback as an error, in any statement', () => {
    for (const row of [play('402'), play('', 'AE402'), play('', '-103'), play('subsctiprionInActive')]) {
      expect(isErr(row)).toBe(false);
      expect(evalCondition(selectedExpr(minuteSql, 'is_err'), row)).toBe(false);
    }
    // A 402 is the paywall, not the origin failing.
    expect(isSrv(play('402'))).toBe(false);
  });

  it('never counts a refused playback as a server error, whatever code the other slot carries', () => {
    for (const row of [play('403', 'AE402'), play('401', '-103'), play('subsctiprionInActive', '2004')]) {
      expect(evalCondition(IS_PAYWALL, row)).toBe(true);
      expect(isSrv(row)).toBe(false);
      expect(isSrv({ ...row, event_type: 'play_stop' })).toBe(false);
    }
  });

  it('keeps every server error an error, so server-error viewers never outnumber error viewers', () => {
    const codes10 = ['', '0', '401', '402', '403', '404', '500', '503', 'subsctiprionInActive', 'true'];
    const codes11 = ['', '-1100', '2004', 'AE402', 'AE403', '-103', 'subsctiprionInActive', 'null'];
    for (const event_type of ['play_start', 'play_stop', 'player_open']) {
      for (const ep10 of codes10) {
        for (const ep11 of codes11) {
          const row = play(ep10, ep11, { event_type });
          if (isSrv(row)) {
            expect([row, isErr(row)]).toEqual([row, true]);
          }
        }
      }
    }
    // The same definition in every statement that selects it.
    const srvExprs = statements()
      .filter((sql) => sql.includes(' AS is_srv'))
      .map((sql) => selectedExpr(sql, 'is_srv'));
    expect(srvExprs.length).toBeGreaterThan(1);
    expect(new Set(srvExprs).size).toBe(1);
  });

  it('still counts real failures: AE403, HTTP codes and stream errors', () => {
    expect(isErr(play('', 'AE403'))).toBe(true);
    expect(isErr(play('403'))).toBe(true);
    expect(isErr(play('', '-1100'))).toBe(true);
    expect(isErr({ event_type: 'play_stop', event_parameter8: 'streamError' })).toBe(true);
    expect(isErr(play(''))).toBe(false);
    expect(isErr(play('true', 'null'))).toBe(false);
    expect(isSrv(play('404'))).toBe(true);
    expect(isSrv(play('', '2004'))).toBe(true);
    expect(isSrv(play('', 'AE403'))).toBe(false);
  });

  it('uses the same definition for the app-level error count', () => {
    expect(activitySql(FROM, TO, null)).toContain(`countIf((${IS_ERR}) AND analytics_version != ''`);
  });
});

describe('provider scope', () => {
  it('maps the org attribute to all / none / a list', () => {
    expect(parseProviderScope('*')).toBeNull();
    expect(parseProviderScope('')).toEqual([]);
    expect(parseProviderScope('111, 222,uvo')).toEqual(['111', '222', 'uvo']);
  });

  it('lets the page filter narrow the org scope but never widen it', () => {
    expect(effectiveScope(null, '')).toBeNull();
    expect(effectiveScope(null, '111')).toEqual(['111']);
    expect(effectiveScope(['111', '222'], '222, 333')).toEqual(['222']);
    expect(effectiveScope([], '111')).toEqual([]);
  });

  it('reads "all" and "*" in the filter as every provider in scope', () => {
    expect(effectiveScope(null, 'All')).toBeNull();
    expect(effectiveScope(['111', '222'], '*')).toEqual(['111', '222']);
    expect(effectiveScope(null, '111 222')).toEqual(['111', '222']);
  });
});
