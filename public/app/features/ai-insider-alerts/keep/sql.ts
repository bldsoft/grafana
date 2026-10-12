// Analytix: AI Insider Alerts — "Keep the customer". SQL of the retention
// scan: one statement per UTC day (or half a day, when a whole day runs out of
// the server's time) returns one row per provider and subscriber account with
// that day's activity, viewing, subscription end and refused playbacks. The
// engine adds the days up into windows, so everything here is per day.
//
// Unlike the Alerts statements, the version gate is NOT in WHERE: set-top
// boxes, Roku and old Smart TVs report no analytics contract but are still a
// customer being active — dropping them would make an STB household look like
// it left. The gate is a WITH alias (`gated`) used only inside the aggregates
// that need the contract (watch time, codes, sessions, subscription).
//
// Complex values (maps, tuples, arrays) come back as toJSONString text and
// times as epoch numbers: the datasource frame would turn DateTime into ISO
// strings and has no stable form for nested types. The search text itself is
// never selected — only whether a search session opened a result.

import { CODE, epoch, IS_ERR, IS_PAYWALL, pidClause, settingsClause, TABLE, VERSION_GATE } from '../sql';

import type { AccountDayRow, DayLevel } from './types';

export const KEEP_LOG_COMMENT = 'ai-insider:keep';

/** Daily pre-aggregates: no account dimension, but a per-day account count state (estimate only). */
const DAILY_TABLE = 'stat.info_v1_7_daily_aggregates_dst';

// Below the bridge's 55 s so the server's own error wins; a day that does not
// fit is read again in halves by the runner. max_result_rows replaces the
// client row cap: a result that is too large fails instead of being cut.
const SETTINGS = settingsClause(KEEP_LOG_COMMENT, {
  maxExecutionSec: 45,
  maxBytesToRead: 20_000_000_000,
  maxResultRows: 400_000,
});

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
/** tvOS session_start / session_end carry the plan of another account: never a subscription source. */
const NOT_SESSION_EVENT = "event_type NOT IN ('session_start', 'session_end')";
/** An event sent while its subscription end (a real one: not unknown, not "no end") had already passed. */
const EXPIRED_EVENT = `subscription_expiration_time > toDateTime(0) AND toYear(subscription_expiration_time) < 2100 AND subscription_expiration_time < event_timestamp AND ${NOT_SESSION_EVENT}`;

type Column = [alias: keyof AccountDayRow, expression: string];

/** Row-level aliases every level needs. */
const LIGHT_WITH: string[] = [
  `(${VERSION_GATE}) AS gated`,
  'toFloat64OrZero(event_parameter14) AS w',
  "multiIf(event_parameter2 IN ('tvShow', 'tvshow', 'show', 'episode'), 'tvshow', event_parameter2 IN ('event', 'live_event', 'liveEvent'), 'event', event_parameter2) AS ctype",
  // Watched seconds for trends: every stop with time (a stop on buffering or an
  // error was still watched — worse quality must not look like lost interest),
  // capped at 4 h, and for on-demand at the title's duration + 100 s.
  "if(event_type = 'play_stop' AND w > 10 AND event_parameter2 NOT IN ('', '1', 'continueWatching') AND event_parameter2 NOT LIKE '%http%', least(w, if(ctype IN ('vod', 'tvshow', 'catchup') AND toFloat64OrZero(event_parameter7) > 0, least(toFloat64OrZero(event_parameter7) + 100, 14400), 14400)), 0) AS wa",
  "(event_type = 'play_start' AND event_parameter8 NOT IN ('userMove', 'userMoveIntro', 'userMoveCredits', 'autoPreview') AND event_parameter2 != 'trailer') AS is_play",
  `(${IS_PAYWALL}) AS paywall`,
  "(paywall AND (event_parameter10 = 'subsctiprionInActive' OR event_parameter11 = 'subsctiprionInActive')) AS inactive",
  // event_parameter9 is a UUID column: compared as text so '' and the zero UUID
  // both mean "no session" (set-top boxes).
  `(toString(event_parameter9) NOT IN ('', '${ZERO_UUID}')) AS sid_ok`,
  // One playback attempt: session + content; without a session (legacy
  // builds), content + hour. Repeated rows of one attempt count once.
  "if(sid_ok, concat(toString(event_parameter9), '@', event_parameter1), concat(event_parameter1, '@', toString(toStartOfHour(event_timestamp)))) AS attempt_key",
];

/** Aliases of the full level only. */
const FULL_WITH: string[] = [
  // The dashboards' watch-time definition, for display next to them only.
  "(event_type = 'play_stop' AND event_parameter8 NOT IN ('streamBuffering', 'streamError') AND event_parameter2 NOT IN ('', '1', 'continueWatching') AND w > 10 AND w < if(event_parameter2 = 'vod', 18000, 10000)) AS is_watch_dash",
  'toFloat64OrZero(event_parameter19) AS off',
  // Junk offsets exist (-30891 on some set-top boxes); an empty one is unknown, not UTC.
  "(event_parameter19 != '' AND abs(off) <= 14) AS off_ok",
  '(paywall AND NOT inactive) AS premium',
  // Sessions with a real search (more than two characters) and sessions that
  // opened something from search; the difference is "searched, found nothing".
  "groupUniqArrayIf(64)(event_parameter9, gated AND event_type = 'search' AND lengthUTF8(trimBoth(event_parameter1)) > 2 AND sid_ok) AS search_sids",
  "groupUniqArrayIf(64)(event_parameter9, gated AND event_type = 'player_open' AND event_parameter6 ILIKE 'search%' AND event_parameter2 != 'trailer' AND sid_ok) AS hit_sids",
  // Watched seconds by the local hour the viewing started (stop time minus the
  // watched time, plus the device's UTC offset). The key is computed on every
  // row before the condition filters: a junk offset (inf, NaN) must not reach
  // the integer cast, which would fail the whole day.
  "sumMapIf([toHour(event_timestamp - toIntervalSecond(toUInt32(round(wa))) + toIntervalSecond(toInt32(round(if(off_ok, off, 0) * 3600))), 'UTC')], [toUInt64(round(wa))], gated AND wa > 0 AND off_ok) AS hour_map",
  // Playback attempts as sets, so a failed one is always one of the playbacks
  // (failed / playbacks never exceeds 1). Keys are hashed: 8 bytes per attempt
  // instead of the key text, and an account-day has few attempts.
  'groupUniqArrayIf(cityHash64(attempt_key), gated AND is_play) AS play_keys',
  // A failure is a technical one: a refusal by the paywall is not (also when
  // only the stop says streamError), and neither are trailers or the home
  // screen's preview starts. A stop's slot 8 is the stop reason, so a failing
  // preview stop is dropped by the playback set, not here.
  `groupUniqArrayIf(cityHash64(attempt_key), gated AND NOT paywall AND event_parameter2 != 'trailer' AND ((event_type = 'play_start' AND (${IS_ERR}) AND event_parameter10 != '0' AND event_parameter8 != 'autoPreview') OR (event_type = 'play_stop' AND event_parameter8 = 'streamError'))) AS failed_keys`,
  // Attempts the paywall refused on any of their rows: never a failed playback.
  'groupUniqArrayIf(cityHash64(attempt_key), paywall) AS refused_keys',
];

const LIGHT_COLUMNS: Column[] = [
  ['pid', 'content_provider_id'],
  ['account', 'content_user_account_number'],
  ['events', 'count()'],
  ['legacy_events', 'countIf(NOT gated)'],
  ['gated_plays', 'countIf(gated AND is_play)'],
  ['ungated_plays', 'countIf(NOT gated AND is_play)'],
  ['watch_all_min', 'round(sumIf(wa, gated) / 60, 1)'],
  [
    'expiry_seen',
    `toJSONString(minMapIf([toUInt32(toUnixTimestamp(subscription_expiration_time))], [toUInt32(toUnixTimestamp(event_timestamp))], subscription_expiration_time > toDateTime(0) AND ${NOT_SESSION_EVENT}))`,
  ],
  ['expired_events', `countIf(${EXPIRED_EVENT})`],
  ['inactive_attempts', 'uniqIf(attempt_key, inactive)'],
  // Per subscription end that had already passed, the first event of the day
  // still reporting it: names the end, so an old value on a second device is
  // not mistaken for the current subscription having ended.
  [
    'expired_reports',
    `toJSONString(minMapIf([toUInt32(toUnixTimestamp(subscription_expiration_time))], [toUInt32(toUnixTimestamp(event_timestamp))], ${EXPIRED_EVENT}))`,
  ],
  ['plan', `argMaxIf(subscription_name, event_timestamp, subscription_name != '' AND ${NOT_SESSION_EVENT})`],
  ['first_ts', 'toUnixTimestamp(min(event_timestamp))'],
  ['last_ts', 'toUnixTimestamp(max(event_timestamp))'],
  ['platforms', "arrayStringConcat(arraySort(groupUniqArray(6)(CAST(device_type AS String))), ',')"],
];

const FULL_COLUMNS: Column[] = [
  ['app_starts', "countIf(event_type = 'session_start')"],
  ['sessions', 'uniqIf(event_parameter9, gated AND sid_ok)'],
  ['play_sessions', "uniqIf(event_parameter9, gated AND event_type IN ('play_start', 'play_stop') AND sid_ok)"],
  ['opens', "countIf(event_type = 'player_open')"],
  ['watch_min', 'round(sumIf(w, gated AND is_watch_dash) / 60, 1)'],
  ['live_min', "round(sumIf(wa, gated AND ctype IN ('tv', 'event')) / 60, 1)"],
  ['ondemand_min', "round(sumIf(wa, gated AND ctype IN ('vod', 'tvshow')) / 60, 1)"],
  ['catchup_min', "round(sumIf(wa, gated AND ctype = 'catchup') / 60, 1)"],
  ['distinct_content', "uniqIf(concat(ctype, ':', event_parameter1), is_play AND event_parameter1 != '')"],
  // What each profile watched most: (profile, type, content id, title) by
  // watched seconds. topKWeighted needs an integer weight.
  [
    'seeds',
    "toJSONString(topKWeightedIf(8, 10, 'counts')(tuple(content_user_profile_id, ctype, event_parameter1, if(startsWith(event_parameter4, '-|'), substring(event_parameter4, 3), event_parameter4)), toUInt64(round(wa)), gated AND wa > 0 AND content_user_profile_id NOT IN ('', '-42') AND event_parameter1 != ''))",
  ],
  ['playbacks', 'length(play_keys)'],
  ['failed_playbacks', 'length(arrayFilter(k -> NOT has(refused_keys, k), arrayIntersect(failed_keys, play_keys)))'],
  ['buffering_stops', "countIf(gated AND event_type = 'play_stop' AND event_parameter8 = 'streamBuffering')"],
  ['top_err_code', `arrayElement(topKIf(1)(${CODE}, gated AND (${IS_ERR})), 1)`],
  ['premium_attempts', 'uniqIf(attempt_key, premium)'],
  ['premium_paid_content', "uniqIf(attempt_key, premium AND event_parameter18 IN ('paid', '1'))"],
  ['paywall_title', 'arrayElement(topKIf(1)(event_parameter4, paywall), 1)'],
  // Refusal rows per "<device_type>|<code>", keyed by each row's own platform,
  // with the candidate forms the paywall definition does not hold yet (103
  // without the dash, 402 in slot 11, AE403): shows which codes each platform
  // really sends.
  [
    'paywall_codes',
    `toJSONString(sumMapIf([concat(CAST(device_type AS String), '|', ${CODE})], [toUInt32(1)], event_type IN ('play_start', 'play_stop') AND (paywall OR replaceAll(event_parameter11, '-', '') IN ('103', '402') OR event_parameter11 = 'AE403')))`,
  ],
  ['search_sessions', 'length(search_sids)'],
  ['failed_search_sessions', 'length(arrayFilter(s -> NOT has(hit_sids, s), search_sids))'],
  ['fav_added', "countIf(event_type = 'favorite_add')"],
  ['fav_removed', "countIf(event_type = 'favorite_remove')"],
  ['org', `argMaxIf(organisation_name, event_timestamp, organisation_name != '' AND ${NOT_SESSION_EVENT})`],
  // Aliased apart from subscription_id / organisation_id on purpose: an alias
  // equal to a column is substituted into its own aggregate (ILLEGAL_AGGREGATION).
  ['sub_id', `argMaxIf(subscription_id, event_timestamp, subscription_id != '' AND ${NOT_SESSION_EVENT})`],
  ['org_id', `argMaxIf(organisation_id, event_timestamp, organisation_id != '' AND ${NOT_SESSION_EVENT})`],
  // Top two [local hour, seconds] pairs of the day.
  [
    'hours',
    'toJSONString(arraySlice(arrayReverseSort(x -> tupleElement(x, 2), arrayZip(tupleElement(hour_map, 1), tupleElement(hour_map, 2))), 1, 2))',
  ],
  ['tz_offset_h', 'if(countIf(gated AND off_ok) = 0, -99, argMaxIf(off, wa, gated AND off_ok))'],
];

/** A day, or half of one: the runner never asks for more, and a mistake must not scan weeks. */
const MAX_SPAN_SEC = 86400;

/**
 * Account-day rows of [from, to) (one UTC day or half of one). `pids === null`
 * means every provider of the organization; an empty list reads nothing.
 * Column aliases are the AccountDayRow field names; `light` returns the
 * activity and subscription columns only (history and outcome days).
 */
export function accountDaysSql(from: number, to: number, pids: string[] | null, level: DayLevel): string {
  if (level !== 'full' && level !== 'light') {
    throw new Error('Invalid day level');
  }
  if (!(to > from) || to - from > MAX_SPAN_SEC) {
    throw new Error('An account-day query covers at most one day');
  }
  const full = level === 'full';
  const withs = full ? [...LIGHT_WITH, ...FULL_WITH] : LIGHT_WITH;
  const columns = full ? [...LIGHT_COLUMNS, ...FULL_COLUMNS] : LIGHT_COLUMNS;
  return `WITH
    ${withs.join(',\n    ')}
SELECT
    ${columns.map(([alias, expr]) => `${expr} AS ${alias}`).join(',\n    ')}
FROM ${TABLE}
WHERE event_timestamp >= ${epoch(from)} AND event_timestamp < ${epoch(to)}${pidClause(pids)}
  AND content_user_account_number != '' AND content_user_account_number NOT LIKE '%-GUEST'
  AND event_type NOT IN ('stream_info', 'cdn_info')
GROUP BY pid, account
${SETTINGS}`;
}

const HALF_DAY_SEC = 43200;

/**
 * Accounts per provider on one day, from the daily aggregates (scan size
 * estimate). The aggregates' `day` is the start of a day in the server's time
 * zone, so the bound is the twelve hours either side of the UTC midnight: it
 * picks the one stored day that mostly overlaps the UTC day, whatever the
 * zone. The count includes the guest and empty-account buckets (one each).
 */
export function estimateSql(dayStart: number, pids: string[] | null): string {
  return `SELECT
    content_provider_id AS pid,
    uniqCombinedMerge(unique_accounts_state) AS accounts
FROM ${DAILY_TABLE}
WHERE day >= ${epoch(dayStart - HALF_DAY_SEC)} AND day < ${epoch(dayStart + HALF_DAY_SEC)}${pidClause(pids)}
GROUP BY pid
${SETTINGS}`;
}
