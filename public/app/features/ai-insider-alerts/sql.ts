// Analytix: SQL for the AI Insider Alerts detector. Every statement reads the
// raw event stream (stat.info_v1_7_dst) for one bounded window and carries the
// clauses the analytics skill makes mandatory: a bound on the bare
// event_timestamp, the dashboards' version gate, an event_type pin before any
// event_parameter read, the guest-aware user identity and the runtime-limit
// SETTINGS footer. Definitions follow skills/clickhouse-api-v3 (quality.md):
// an error is a streamError stop or a real code in slot 10/11 of a play event.
//
// Bounds are passed as epoch seconds: event_timestamp holds absolute instants
// and toDateTime(<epoch>) is time-zone independent, unlike a date string that
// ClickHouse would parse in the server's time zone.

import type { AlertRules } from './types';

const TABLE = 'stat.info_v1_7_dst';

const VERSION_GATE =
  "analytics_version != '' AND (device_type != 'SmartTV' OR tuple(toUInt32OrZero(splitByChar('.', app_releaseVersion)[1]), toUInt32OrZero(splitByChar('.', app_releaseVersion)[2]), toUInt32OrZero(splitByChar('.', app_releaseVersion)[3])) >= (3, 34, 2))";

const USER_ID =
  "multiIf(content_user_account_number != '' AND content_user_account_number NOT LIKE '%-GUEST', content_user_account_number, device_type != 'web', device_serial_number, network_ip)";

// Error on a playback event: a technical stop or a real HTTP / player code.
const IS_ERR =
  "(event_type = 'play_stop' AND event_parameter8 = 'streamError') OR (event_type IN ('play_start', 'play_stop') AND (event_parameter10 NOT IN ('', 'true', 'continueWatching', 'subsctiprionInActive') OR event_parameter11 NOT IN ('', 'true', 'null', 'unknown', 'continueWatching', 'subsctiprionInActive')))";

// Server-side error: the origin / CDN answered 4xx/5xx, or the player reported
// "stream not found" (-1100 iOS, 2004 Android bad HTTP status).
const IS_SRV_ERR =
  "event_type IN ('play_start', 'play_stop') AND (match(event_parameter10, '^[45][0-9][0-9]$') OR event_parameter11 IN ('-1100', '2004'))";

const CODE =
  "concat(if(event_parameter10 = '', '-', event_parameter10), '/', if(event_parameter11 = '', '-', event_parameter11))";

// Stream path without scheme, host, playlist file and query string, so the same
// origin stream served through two hosts (two operators) gets one key. Some
// operators sign URLs inside the path (`data=ip=…,id=<account>,…/<sha256>/`):
// segments with `=` or a long hex digest are dropped, which keeps the key
// stable per stream and keeps viewer IPs and account ids out of the page.
const STREAM_PATH =
  "trim(BOTH '/' FROM replaceRegexpAll(replaceRegexpOne(replaceRegexpOne(replaceRegexpOne(event_parameter3, '[?#].*$', ''), '^[a-zA-Z]+[:-]//[^/]+/?', ''), '(^|/)[^/]*[.][a-zA-Z0-9]+$', ''), '(^|/)[^/]*(=|[0-9a-fA-F]{32,})[^/]*', ''))";

const SETTINGS = `SETTINGS max_execution_time = 60,
         max_memory_usage = 12000000000,
         max_bytes_to_read = 100000000000,
         read_overflow_mode = 'throw',
         log_comment = 'ai-insider:alerts'`;

const PID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Provider ids that are safe to inline into SQL; anything else is dropped. */
export function sanitizePids(pids: string[]): string[] {
  return Array.from(new Set(pids.map((p) => p.trim()).filter((p) => PID_RE.test(p))));
}

function pidClause(pids: string[] | null): string {
  if (pids === null) {
    return '';
  }
  const safe = sanitizePids(pids);
  // An empty scope must read nothing rather than everything (fail closed).
  const clause = safe.length ? `content_provider_id IN (${safe.map((p) => `'${p}'`).join(', ')})` : '0';
  return `\n      AND ${clause}`;
}

function epoch(sec: number): string {
  if (!Number.isFinite(sec)) {
    throw new Error('Invalid time bound');
  }
  return `toDateTime(${Math.floor(sec)})`;
}

/**
 * The live-TV playback rows of one window, one row per player event, with the
 * derived columns every query below groups on. `pids === null` means all
 * providers; an empty array means none.
 */
function baseRows(from: number, to: number, pids: string[] | null): string {
  return `SELECT
        event_timestamp AS ts,
        toStartOfMinute(event_timestamp) AS minute,
        content_provider_id AS pid,
        event_parameter1 AS cid,
        event_parameter4 AS ch_title,
        event_type AS et,
        device_type AS platform,
        network_type AS network,
        ${USER_ID} AS user_id,
        (${IS_ERR}) AS is_err,
        (${IS_SRV_ERR}) AS is_srv,
        ${CODE} AS code,
        ${STREAM_PATH} AS path,
        domain(event_parameter3) AS host,
        toFloat64OrZero(event_parameter14) AS watch
    FROM ${TABLE}
    WHERE event_timestamp >= ${epoch(from)} AND event_timestamp < ${epoch(to)}
      AND event_type IN ('player_open', 'play_start', 'play_stop')
      AND event_parameter2 = 'tv'
      AND event_parameter1 != ''${pidClause(pids)}
      AND ${VERSION_GATE}`;
}

/** Query A: the failing channel-minutes of a window. */
export function badMinutesSql(from: number, to: number, pids: string[] | null, rules: AlertRules): string {
  return `SELECT
    toUnixTimestamp(minute) AS minute_ts,
    pid,
    cid,
    any(ch_title) AS channel_title,
    uniq(user_id) AS users,
    uniqIf(user_id, is_err) AS err_users,
    countIf(is_err) AS err_events,
    uniqIf(user_id, is_srv) AS srv_err_users,
    arrayElement(topKIf(1)(path, is_err), 1) AS top_path,
    arrayElement(topKIf(1)(host, is_err), 1) AS top_host,
    arrayElement(topKIf(1)(platform, is_err), 1) AS top_platform,
    arrayElement(topKIf(1)(code, is_err), 1) AS top_code
FROM (
    ${baseRows(from, to, pids)}
)
GROUP BY minute, pid, cid
HAVING users >= ${Math.max(1, Math.floor(rules.minUsers))}
   AND err_users >= ${Math.max(1, Math.floor(rules.minErrUsers))}
   AND err_users >= ${Number(rules.minErrShare).toFixed(4)} * users
ORDER BY minute_ts, pid, cid
${SETTINGS}`;
}

export interface IncidentWindow {
  id: string;
  pid: string;
  cid: string;
  /** First bad minute (epoch seconds). */
  start: number;
  /** End of the window to read (exclusive). */
  end: number;
}

const LOOKBACK_SEC = 3600;
const ERR_LEAD_SEC = 120;

/**
 * Query B: the viewers hit by each incident in `windows`, with their first and
 * last error, error count and clean viewing of the channel in the hour before
 * the incident (the apology criterion). Errors count from two minutes before
 * the first bad minute: the leading edge of an outage is usually just below
 * the thresholds.
 */
export function affectedUsersSql(windows: IncidentWindow[], pids: string[] | null): string {
  if (!windows.length) {
    throw new Error('No incidents to query');
  }
  const from = Math.min(...windows.map((w) => w.start)) - LOOKBACK_SEC;
  const to = Math.max(...windows.map((w) => w.end));
  const branches = windows.map((w, i) => {
    if (!PID_RE.test(w.pid) || !PID_RE.test(w.cid)) {
      throw new Error('Invalid incident key');
    }
    return `pid = '${w.pid}' AND cid = '${w.cid}' AND ts >= ${epoch(w.start - LOOKBACK_SEC)} AND ts < ${epoch(w.end)}, ${i}`;
  });
  const errFrom = windows.map((w, i) => `inc = ${i}, ${Math.floor(w.start - ERR_LEAD_SEC)}`);

  return `SELECT
    inc,
    user_id,
    any(platform) AS platform_any,
    any(network) AS network_any,
    minIf(ts_s, hit) AS first_err,
    maxIf(ts_s, hit) AS last_err,
    countIf(hit) AS err_events,
    arrayElement(topKIf(1)(code, hit), 1) AS top_code,
    sumIf(watch, et = 'play_stop' AND NOT is_err AND watch > 0 AND watch < 20000 AND ts_s < err_from + ${ERR_LEAD_SEC}) AS watched_before
FROM (
    SELECT *, toUnixTimestamp(ts) AS ts_s, is_err AND ts_s >= err_from AS hit
    FROM (
        SELECT *,
            multiIf(${branches.join(', ')}, -1) AS inc,
            multiIf(${errFrom.join(', ')}, 0) AS err_from
        FROM (
            ${baseRows(from, to, pids)}
        )
    )
    WHERE inc >= 0
)
GROUP BY inc, user_id
HAVING err_events > 0
ORDER BY inc, first_err
${SETTINGS}`;
}

/**
 * Query C: viewers failing on channels that are healthy for everyone else in
 * the same minute — the customer-side candidates (home Wi-Fi, device, ISP).
 */
export function customerSideSql(from: number, to: number, pids: string[] | null, rules: AlertRules): string {
  return `SELECT
    e.pid AS pid,
    e.user_id AS user_id,
    any(e.platform) AS platform_any,
    any(e.network) AS network_any,
    uniqExact(e.cid) AS channels,
    uniqExact(e.minute) AS minutes,
    count() AS err_events,
    toUnixTimestamp(min(e.minute)) AS first_minute,
    toUnixTimestamp(max(e.minute)) AS last_minute,
    arrayElement(topK(1)(e.code), 1) AS top_code
FROM (
    SELECT minute, pid, cid, user_id, platform, network, code
    FROM (
        ${baseRows(from, to, pids)}
    )
    WHERE is_err
) AS e
GLOBAL ANY LEFT JOIN (
    SELECT minute, pid, cid, uniq(user_id) AS users, uniqIf(user_id, is_err) AS err_users
    FROM (
        ${baseRows(from, to, pids)}
    )
    GROUP BY minute, pid, cid
    HAVING err_users > 0
) AS c ON e.minute = c.minute AND e.pid = c.pid AND e.cid = c.cid
WHERE NOT (c.users >= ${Math.max(1, Math.floor(rules.minUsers))}
           AND c.err_users >= ${Math.max(1, Math.floor(rules.minErrUsers))}
           AND c.err_users >= ${Number(rules.minErrShare).toFixed(4)} * c.users)
GROUP BY e.pid, e.user_id
HAVING channels >= ${Math.max(1, Math.floor(rules.customerMinChannels))}
   AND minutes >= ${Math.max(1, Math.floor(rules.customerMinMinutes))}
ORDER BY err_events DESC
${SETTINGS}`;
}

/** Query D: per-channel server errors vs clean viewing (dead-channel detection). */
export function channelHealthSql(from: number, to: number, pids: string[] | null): string {
  return `SELECT
    pid,
    cid,
    any(ch_title) AS channel_title,
    uniqIf(user_id, is_srv) AS srv_err_users,
    uniqIf(user_id, et = 'play_stop' AND NOT is_err AND watch >= 60) AS ok_users,
    uniqIf(user_id, et IN ('player_open', 'play_start')) AS tried_users
FROM (
    ${baseRows(from, to, pids)}
)
GROUP BY pid, cid
HAVING srv_err_users > 0
${SETTINGS}`;
}

/** Query E: total error volume of a window (the naive "message per error" baselines). */
export function errorVolumeSql(from: number, to: number, pids: string[] | null): string {
  return `SELECT
    countIf(is_err) AS err_events,
    uniqIf(user_id, is_err) AS err_users,
    uniqIf(tuple(user_id, minute), is_err) AS user_err_minutes
FROM (
    ${baseRows(from, to, pids)}
)
${SETTINGS}`;
}

/**
 * Provider names for the given ids. Kept out of the detection queries on
 * purpose: a dictionary whose source is unavailable throws even through
 * dictGetOrDefault, and names are cosmetic — the page falls back to the ids.
 */
export function providerNamesSql(pids: string[]): string {
  const safe = sanitizePids(pids);
  if (!safe.length) {
    throw new Error('No providers to resolve');
  }
  return `SELECT
    pid,
    dictGet('default.provider', 'providerName', toUInt64(toUInt32OrZero(pid))) AS provider
FROM (SELECT arrayJoin([${safe.map((p) => `'${p}'`).join(', ')}]) AS pid)
${SETTINGS}`;
}
