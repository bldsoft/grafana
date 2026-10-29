import { isSafeBridgeSql } from 'app/features/dashboard-scene/ai-panel/datasourceQuery';

import {
  CDN_BUCKET_SEC,
  CdnStatusRow,
  CdnTarget,
  cdnStatusSql,
  channelCdnTarget,
  evaluateCdn,
  providerCdnTarget,
  streamOfPath,
} from './cdn';
import type { Incident, ProviderIncident } from './types';

const T0 = Date.UTC(2026, 9, 28, 14, 2) / 1000;

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'inc-1',
    pid: '255',
    provider: 'Mediablocks',
    cid: '1',
    title: 'Televen HD',
    start: T0,
    lastBad: T0 + 3 * 60,
    closedAt: T0 + 13 * 60,
    recovered: true,
    cleanStreak: 5,
    badMinutes: 2,
    peakUsers: 12,
    peakErrUsers: 4,
    peakErrShare: 0.3,
    errEvents: 20,
    srvErrUsersMax: 3,
    series: [],
    paths: { '10255/dvr/hls/televentrx': 12, 'prn2/10008/live/hls/topnews/0_0_2000_128': 2 },
    hosts: {},
    platforms: {},
    codes: {},
    chronic: false,
    unstable: false,
    ...overrides,
  };
}

function target(): CdnTarget {
  return channelCdnTarget(incident(), T0 + 3600)!;
}

/** One status of one 5-minute bucket, `offset` buckets from the problem's bucket. */
function row(offset: number, status: number, requests: number, cdn = 'fastly'): CdnStatusRow {
  const bucket = Math.floor(T0 / CDN_BUCKET_SEC) * CDN_BUCKET_SEC + offset * CDN_BUCKET_SEC;
  return { bucket, cdn, status, requests };
}

describe('CDN confirmation', () => {
  it('takes the stream name the CDN logs under from a player path', () => {
    expect(streamOfPath('10255/dvr/hls/televentrx')).toBe('televentrx');
    expect(streamOfPath('prn2/10008/live/hls/topnews/0_0_2000_128')).toBe('topnews');
    expect(streamOfPath('prn2/10008/live-drm/dash/artpulse1')).toBe('artpulse1');
    expect(streamOfPath('vod/movie')).toBeUndefined();
    expect(streamOfPath("x/hls/a'b")).toBeUndefined();
  });

  it('reads the top streams of a channel from half an hour before it, on 5-minute boundaries', () => {
    const t = target();
    expect(t.pid).toBe(255);
    expect(t.streams).toEqual(['televentrx', 'topnews']);
    expect(t.from).toBe(Date.UTC(2026, 9, 28, 13, 30) / 1000);
    expect(t.to).toBe(Date.UTC(2026, 9, 28, 14, 15) / 1000);
  });

  it('has no target for a provider id the CDN logs cannot hold, or a path without a stream', () => {
    expect(channelCdnTarget(incident({ pid: 'uvo' }), T0)).toBeUndefined();
    expect(channelCdnTarget(incident({ paths: { 'vod/movie': 3 } }), T0)).toBeUndefined();
  });

  it('reads an open problem up to now, rounded up to a bucket', () => {
    const t = channelCdnTarget(incident({ closedAt: undefined }), T0 + 20 * 60 + 10)!;
    expect(t.end).toBe(Date.UTC(2026, 9, 28, 14, 25) / 1000);
    const p = providerCdnTarget(
      { pid: '222', start: T0, lastSurge: T0, closedAt: T0 + 1800 } as ProviderIncident,
      900,
      T0 + 7200
    )!;
    expect(p.streams).toEqual([]);
    expect(p.end).toBe(T0 + 1800);
  });

  it('builds one bounded read of sum5mins that passes the client-side gate', () => {
    const sql = cdnStatusSql(target());
    expect(isSafeBridgeSql(sql)).toBe(true);
    expect(sql).toContain('FROM stream_logs.sum5mins');
    expect(sql).toContain('WHERE pid = 255');
    expect(sql).toContain("stream_name IN ('televentrx', 'topnews')");
    expect(sql).toMatch(/time >= toDateTime\(\d+\) AND time < toDateTime\(\d+\)/);
    expect(cdnStatusSql({ ...target(), streams: [] })).not.toContain('stream_name');
    expect(() => cdnStatusSql({ ...target(), streams: ["a' OR 1"] })).toThrow();
  });

  it('confirms when the edge failed the stream during the problem, well above before', () => {
    const check = evaluateCdn(
      [row(-2, 200, 1000), row(-2, 404, 2), row(0, 200, 600), row(0, 404, 300), row(0, 499, 50), row(1, 503, 100)],
      target()
    );
    expect(check.verdict).toBe('confirmed');
    expect(check.requests).toBe(1050);
    expect(check.errors).toBe(400);
    expect(check.shareBefore).toBeCloseTo(2 / 1002);
    expect(check.codes).toEqual([
      { status: 404, requests: 300 },
      { status: 503, requests: 100 },
    ]);
    expect(check.cdns).toEqual([{ cdn: 'fastly', requests: 1050, errors: 400 }]);
  });

  it('does not confirm when the stream failed as much before, or the CDN served it fine', () => {
    expect(
      evaluateCdn([row(-2, 200, 900), row(-2, 403, 100), row(0, 200, 850), row(0, 403, 150)], target()).verdict
    ).toBe('clean');
    expect(evaluateCdn([row(0, 200, 5000), row(0, 499, 900)], target()).verdict).toBe('clean');
  });

  it('says there are no CDN logs when nothing was requested', () => {
    expect(evaluateCdn([], target()).verdict).toBe('none');
  });
});
