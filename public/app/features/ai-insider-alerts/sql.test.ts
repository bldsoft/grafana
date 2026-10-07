import { isSafeBridgeSql } from 'app/features/dashboard-scene/ai-panel/datasourceQuery';

import { effectiveScope, parseProviderScope } from './scope';
import {
  affectedUsersSql,
  badMinutesSql,
  channelHealthSql,
  channelMinutesSql,
  customerSideSql,
  errorVolumeSql,
  providerNamesSql,
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

  it('rejects malformed incident keys instead of inlining them', () => {
    expect(() => affectedUsersSql([{ id: 'x', pid: '222', cid: "1' OR 1", start: FROM, end: TO }], null)).toThrow();
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
