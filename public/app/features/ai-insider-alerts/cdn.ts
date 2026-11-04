// Analytix: AI Insider Alerts - does the CDN see the problem too? The player
// reports an error; the CDN access logs (stream_logs.sum5mins: Fastly, Akamai
// and Cachefly per 5 minutes, status and stream) say whether the edge answered
// the same stream with 4xx/5xx at the same time. Read on demand for one
// problem, through the same ClickHouse datasource as the run. Definitions
// follow skills/clickhouse-api-v3/domains/cdn_logs.md: an edge error is a
// status >= 400 except 499 (the client closed the connection).

import { num, str } from './coerce';
import { epoch, settingsClause } from './sql';
import type { Incident, ProviderIncident } from './types';

export const CDN_BUCKET_SEC = 300;
/** The level the problem is compared with: this long before it started. */
export const CDN_BEFORE_SEC = 30 * 60;
/** At most this many stream names of a channel (its top player paths). */
const MAX_STREAMS = 3;

/** Confirmed: at least this many failed requests during the problem… */
export const CDN_MIN_ERRORS = 20;
/** …at least this share of the stream's requests… */
export const CDN_MIN_ERROR_SHARE = 0.05;
/** …and this many times the share before it (when there was enough traffic before to compare). */
export const CDN_MIN_RATIO = 3;
const MIN_BEFORE_REQUESTS = 100;
/**
 * Requests per 5 minutes during the problem at most this share of the level
 * before: viewers stopped reaching the edge at all. A DNS failure, a broken
 * multi-CDN steering step (the player never gets a CDN host) or a network
 * outage before the edge leave no error in the CDN logs, only missing traffic.
 */
export const CDN_DROP_SHARE = 0.5;
/** The CDN logs land this late: the newest buckets are not complete yet. */
export const CDN_LOG_LAG_SEC = 10 * 60;

const STREAM_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const SETTINGS = settingsClause('ai-insider:alerts-cdn', { maxExecutionSec: 30, maxResultRows: 20_000 });

/** What one CDN check reads: a provider, optionally some of its streams, a time range. */
export interface CdnTarget {
  /** stream_logs.pid is a number: a provider id that is not one has no CDN logs. */
  pid: number;
  /** Empty = the whole provider. */
  streams: string[];
  /** The problem itself (epoch seconds). */
  start: number;
  end: number;
  /** The range read: CDN_BEFORE_SEC before the problem, on 5-minute boundaries. */
  from: number;
  to: number;
}

/**
 * The stream name the CDN logs under, from a player path as the detector keys
 * it (`<origin>/<live|dvr>/<hls|dash>/<stream>[/<rendition>]`, host and file
 * already cut). The CDN's `stream_name` matches it for ~97% of plays.
 */
export function streamOfPath(path: string): string | undefined {
  const m = /(?:^|\/)(?:hls|dash|cmaf)\/([^/]+)/.exec(path);
  return m && STREAM_RE.test(m[1]) ? m[1] : undefined;
}

function cdnWindow(pid: string, streams: string[], start: number, end: number): CdnTarget | undefined {
  if (!/^\d{1,5}$/.test(pid) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return undefined;
  }
  const from = Math.floor(start / CDN_BUCKET_SEC) * CDN_BUCKET_SEC - CDN_BEFORE_SEC;
  const to = Math.ceil(end / CDN_BUCKET_SEC) * CDN_BUCKET_SEC;
  return { pid: Number(pid), streams, start, end, from, to };
}

// An open problem reaches up to now, rounded up to a CDN bucket: the check is
// read again every 5 minutes of a live run, not on every tick.
function openEnd(lastSeen: number, now: number): number {
  return Math.ceil(Math.max(lastSeen, now) / CDN_BUCKET_SEC) * CDN_BUCKET_SEC;
}

/** A channel problem: its top streams; undefined when no path names a stream. */
export function channelCdnTarget(incident: Incident, now: number): CdnTarget | undefined {
  const streams = Object.entries(incident.paths)
    .sort((a, b) => b[1] - a[1])
    .map(([path]) => streamOfPath(path))
    .filter((s): s is string => s !== undefined);
  const unique = Array.from(new Set(streams)).slice(0, MAX_STREAMS);
  if (!unique.length) {
    return undefined;
  }
  return cdnWindow(incident.pid, unique, incident.start, incident.closedAt ?? openEnd(incident.lastBad + 60, now));
}

/** A provider-wide problem: every stream of the provider. */
export function providerCdnTarget(incident: ProviderIncident, bucketSec: number, now: number): CdnTarget | undefined {
  return cdnWindow(incident.pid, [], incident.start, incident.closedAt ?? openEnd(incident.lastSurge + bucketSec, now));
}

/**
 * The time axis every chart of one problem shares, so the player's errors and
 * the CDN's sit on the same clock: from CDN_BEFORE_SEC before the problem to
 * its end, on CDN bucket edges, widened to whatever the analytics chart covers.
 */
export function problemChartRange(
  start: number,
  end: number,
  analytics?: { from: number; to: number }
): { from: number; to: number } {
  const from = Math.floor(start / CDN_BUCKET_SEC) * CDN_BUCKET_SEC - CDN_BEFORE_SEC;
  const to = Math.ceil(end / CDN_BUCKET_SEC) * CDN_BUCKET_SEC;
  return {
    from: Math.min(from, analytics?.from ?? from),
    to: Math.max(to, analytics?.to ?? to),
  };
}

/** A problem on the charts: the shared axis and the problem period shaded on it. */
export interface ProblemChartFrame {
  range: { from: number; to: number };
  highlight: { from: number; to: number };
}

export function channelChartFrame(incident: Incident, now: number): ProblemChartFrame {
  const end = incident.closedAt ?? Math.max(incident.lastBad + 60, now);
  return {
    range: problemChartRange(incident.start, end, { from: incident.start, to: end }),
    highlight: { from: incident.start, to: end },
  };
}

export function providerChartFrame(incident: ProviderIncident, bucketSec: number, now: number): ProblemChartFrame {
  const end = incident.closedAt ?? Math.max(incident.lastSurge + bucketSec, now);
  const first = incident.series[0]?.bucket ?? incident.start;
  const last = (incident.series[incident.series.length - 1]?.bucket ?? incident.lastSurge) + bucketSec;
  return {
    range: problemChartRange(incident.start, end, { from: first, to: last }),
    highlight: { from: incident.start, to: end },
  };
}

/** Requests per 5 minutes, CDN and status of the target. */
export function cdnStatusSql(target: CdnTarget): string {
  if (!Number.isInteger(target.pid) || target.pid < 0 || target.streams.some((s) => !STREAM_RE.test(s))) {
    throw new Error('Invalid CDN target');
  }
  const streams = target.streams.length
    ? `\n  AND stream_name IN (${target.streams.map((s) => `'${s}'`).join(', ')})`
    : '';
  return `SELECT
    toUnixTimestamp(time) AS bucket_ts,
    toString(provider) AS cdn,
    toUInt16OrZero(toString(http_status)) AS status,
    sum(requests) AS request_count
FROM stream_logs.sum5mins
WHERE pid = ${target.pid}
  AND time >= ${epoch(target.from)} AND time < ${epoch(target.to)}${streams}
GROUP BY bucket_ts, cdn, status
ORDER BY bucket_ts, cdn, status
${SETTINGS}`;
}

export interface CdnStatusRow {
  bucket: number;
  cdn: string;
  status: number;
  requests: number;
}

export function toCdnStatus(r: Record<string, unknown>): CdnStatusRow {
  return { bucket: num(r.bucket_ts), cdn: str(r.cdn), status: num(r.status), requests: num(r.request_count) };
}

export const isEdgeError = (status: number) => status >= 400 && status !== 499;

export interface CdnBucket {
  bucket: number;
  requests: number;
  errors: number;
}

export interface CdnPerCdn {
  cdn: string;
  requests: number;
  errors: number;
}

/**
 * `confirmed`: the edge failed the stream during the problem, well above its
 * level before; `dropped`: no more errors at the edge, but far fewer requests
 * reached it than before (the failure is before the CDN: DNS, multi-CDN
 * steering, network); `clean`: the CDN served it about as usual; `none`: the
 * CDN logs have no requests for it (another CDN, or the provider is not logged).
 */
export type CdnVerdict = 'confirmed' | 'dropped' | 'clean' | 'none';

export interface CdnCheck {
  verdict: CdnVerdict;
  /** During the problem. */
  requests: number;
  errors: number;
  /** In the CDN_BEFORE_SEC before it; undefined when there was too little traffic to compare. */
  shareBefore?: number;
  /**
   * Requests per 5 minutes during the problem against before it (complete
   * buckets only); undefined when there was too little traffic before.
   */
  trafficRatio?: number;
  /** Edge error statuses during the problem, most frequent first. */
  codes: Array<{ status: number; requests: number }>;
  /** Per CDN during the problem, most requests first. */
  cdns: CdnPerCdn[];
  buckets: CdnBucket[];
}

/**
 * `now`: the wall clock, so the buckets the CDN logs have not filled yet do not
 * read as a traffic drop (Infinity = all complete).
 */
export function evaluateCdn(rows: CdnStatusRow[], target: CdnTarget, now = Infinity): CdnCheck {
  const buckets = new Map<number, CdnBucket>();
  const complete = Math.floor((now - CDN_LOG_LAG_SEC) / CDN_BUCKET_SEC) * CDN_BUCKET_SEC;
  const firstDuring = Math.floor(target.start / CDN_BUCKET_SEC) * CDN_BUCKET_SEC;
  let completeRequests = 0;
  const codes = new Map<number, number>();
  const cdns = new Map<string, CdnPerCdn>();
  let requests = 0;
  let errors = 0;
  let beforeRequests = 0;
  let beforeErrors = 0;

  for (const r of rows) {
    const err = isEdgeError(r.status) ? r.requests : 0;
    const b = buckets.get(r.bucket) ?? { bucket: r.bucket, requests: 0, errors: 0 };
    b.requests += r.requests;
    b.errors += err;
    buckets.set(r.bucket, b);

    // The 5-minute bucket the problem starts in counts as during it.
    if (r.bucket + CDN_BUCKET_SEC <= target.start) {
      beforeRequests += r.requests;
      beforeErrors += err;
      continue;
    }
    if (r.bucket >= target.end) {
      continue;
    }
    if (r.bucket + CDN_BUCKET_SEC <= complete) {
      completeRequests += r.requests;
    }
    requests += r.requests;
    errors += err;
    if (err) {
      codes.set(r.status, (codes.get(r.status) ?? 0) + err);
    }
    const c = cdns.get(r.cdn) ?? { cdn: r.cdn, requests: 0, errors: 0 };
    c.requests += r.requests;
    c.errors += err;
    cdns.set(r.cdn, c);
  }

  const shareBefore = beforeRequests >= MIN_BEFORE_REQUESTS ? beforeErrors / beforeRequests : undefined;
  const share = requests ? errors / requests : 0;
  const confirmed =
    errors >= CDN_MIN_ERRORS &&
    share >= CDN_MIN_ERROR_SHARE &&
    (shareBefore === undefined || share >= CDN_MIN_RATIO * shareBefore);
  const beforeBuckets = Math.max(1, (firstDuring - target.from) / CDN_BUCKET_SEC);
  const duringBuckets = Math.max(0, (Math.min(target.end, complete) - firstDuring) / CDN_BUCKET_SEC);
  const completeBuckets = Math.floor(duringBuckets);
  const trafficRatio =
    beforeRequests >= MIN_BEFORE_REQUESTS && completeBuckets >= 1
      ? completeRequests / completeBuckets / (beforeRequests / beforeBuckets)
      : undefined;
  const dropped = trafficRatio !== undefined && trafficRatio <= CDN_DROP_SHARE;
  const verdict: CdnVerdict = confirmed
    ? 'confirmed'
    : dropped
      ? 'dropped'
      : requests || beforeRequests
        ? 'clean'
        : 'none';

  return {
    verdict,
    requests,
    errors,
    shareBefore,
    trafficRatio,
    codes: [...codes.entries()].map(([status, n]) => ({ status, requests: n })).sort((a, b) => b.requests - a.requests),
    cdns: [...cdns.values()].sort((a, b) => b.requests - a.requests),
    buckets: [...buckets.values()].sort((a, b) => a.bucket - b.bucket),
  };
}
