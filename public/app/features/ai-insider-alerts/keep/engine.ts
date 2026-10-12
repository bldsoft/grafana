// Analytix: AI Insider Alerts — "Keep the customer": the retention engine.
// Pure TypeScript with no Grafana dependencies (like the Alerts engine), so the
// same rules can later move to a server-side runner unchanged. It holds the
// account-day rows of the Analytix event stream per UTC day in typed arrays
// and answers, for an as-of day: which customers are at risk, why (a business
// reason), what would be done about it and when — and, in a backtest, what
// happened next. Nothing is sent from here.
//
// Memory and speed: a scan holds up to ~100k accounts × 40-70 days. Rows are
// copied into compact per-day columns at ingest (account keys interned to
// integer ids, strings to string ids), and an evaluation is one linear pass
// over the window's rows into per-account typed-array accumulators. Objects
// are only built for accounts that end up in a list.

import { cellNumber, numAt, optNumAt, strAt } from './blocks';
import {
  KEEP_DAY_SETTLE_SEC,
  type AccountAssessment,
  type AccountDayRow,
  type BacktestReport,
  type BacktestRow,
  type BacktestSession,
  type BehaviorMetrics,
  type BehaviorResult,
  type BehaviorStatus,
  type DayBlock,
  type DayLevel,
  type Delivery,
  type EvaluateOptions,
  type Evidence,
  type EvidenceCode,
  type JobStep,
  type KeepAction,
  type KeepEngineApi,
  type KeepEngineOptions,
  type KeepJob,
  type KeepQuality,
  type KeepReason,
  type KeepRules,
  type KeepSnapshot,
  type OfferKind,
  type OfferTool,
  type OutcomeGroup,
  type PlanClass,
  type PriorityTier,
  type RenewalItem,
  type RenewalStyle,
  type Seed,
  type WindowStats,
} from './types';

const DAY = 86400;
const HOUR = 3600;
/** Subscription ends from 2100 on are the "no end" sentinel the apps send (2106). */
const NO_END_SEC = Date.UTC(2100, 0, 1) / 1000;
/** An end moved back to (almost) the moment it was seen: a void, refund or admin action. */
const DEACTIVATION_SLACK_SEC = 120;
/** A renewal that keeps the old end's time of day (±10 min) extends the old term. */
const TIME_OF_DAY_SLACK_SEC = 600;
/** A new end first seen this long before the old one ran out: renewed by hand, early. */
const EARLY_RENEWAL_SEC = 36 * HOUR;
/**
 * A device reports its cached (passed) end until it refreshes the
 * subscription, usually within minutes of the renewal: only a report at least
 * this long before the new end appeared means the customer was really without
 * a subscription in between.
 */
const RENEWAL_REFRESH_SLACK_SEC = HOUR;
/** Seeds kept per account-day (the SQL's topK), per assessment and per job. */
const DAY_SEEDS = 8;
const ASSESSMENT_SEEDS = 8;
const JOB_SEEDS = 5;
const U16_MAX = 65535;
const U32_MAX = 4294967295;
/** Live TV share of the watch time from which the recommendations start from channels. */
const LIVE_SHARE_FOR_CHANNELS = 0.7;
/** CRM agents call during the local working day. */
const CRM_LOCAL_HOUR = 10;
/** A future end this many days away (or more) adds no urgency. */
const URGENCY_DAYS = 30;
/** Baseline watch per day that makes a customer fully "valuable". */
const VALUE_WATCH_MIN = 120;
/** No content evidence: the reason is a guess, so the job is weaker. */
const DISENGAGED_SEVERITY = 0.6;
/** At-term renewal with fading engagement: the content push is due this long before the end. */
const AT_TERM_CONTENT_LEAD_DAYS = 2;
/** Base rate for the minimum detectable effect until a backtest measured one. */
const DEFAULT_BASE_RATE = 0.2;
/** ≈ z(0.975) + z(0.8): 95% confidence, 80% power. */
const MDE_Z = 2.8;
// GA4 evidence thresholds (counts over the recent window).
const GA4_CRASH_DAYS_MIN = 2;
const GA4_ERROR_SCREENS_MIN = 2;
const GA4_SEARCH_NO_PLAY_MIN = 2;
const GA4_BROWSE_NO_PLAY_MIN = 3;
const GA4_ACCOUNT_VISITS_MIN = 2;
const GA4_LOGOUT_MIN = 1;

// Style codes in Core.style (0 = unknown).
const STYLE_AT_TERM = 1;
const STYLE_EARLY = 2;
const STYLE_REPURCHASE = 3;
const STYLES: RenewalStyle[] = ['unknown', 'at_term', 'early', 'repurchase'];

const OUTCOME_GROUPS: OutcomeGroup[] = ['price', 'timing', 'content', 'disengaged', 'quiet'];

const floorDay = (t: number) => Math.floor(t / DAY) * DAY;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, digits = 3) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
const u16 = (v: number) => (v >= U16_MAX ? U16_MAX : v);
const u32 = (v: number) => (v >= U32_MAX ? U32_MAX : v);
const mod = (v: number, m: number) => ((v % m) + m) % m;
/**
 * Whole days of a day-count rule (at least 1). The runner plans its reads with
 * the same helpers, so the days read and the windows evaluated always agree.
 */
export const ruleDays = (n: number) => Math.max(1, Math.floor(Number.isFinite(n) ? n : 1));
/** Whole days of a rule that may be 0 (grace days). */
export const graceDays = (n: number) => Math.max(0, Math.floor(Number.isFinite(n) ? n : 0));

/** The first moment at or after `floor` that is `localHour` o'clock at UTC offset `tz` (hours). */
function slotAtOrAfter(floor: number, localHour: number, tz: number): number {
  return floor + mod(Math.round((localHour - tz) * HOUR) - mod(floor, DAY), DAY);
}

// ---------------------------------------------------------------------------
// Exported helpers

const PID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** `111=crm, 222=push` → { '111': 'crm', '222': 'push' } (unknown words are ignored). */
export function parseDeliveryByPid(text: string): Record<string, Delivery> {
  const out: Record<string, Delivery> = {};
  for (const part of String(text ?? '').split(/[,;\n]+/)) {
    const m = /^\s*([^=:\s]+)\s*[=:]\s*([A-Za-z]+)\s*$/.exec(part);
    if (!m || !PID_RE.test(m[1])) {
      continue;
    }
    const word = m[2].toLowerCase();
    if (word === 'push' || word === 'crm' || word === 'none') {
      out[m[1]] = word;
    }
  }
  return out;
}

/** Upper case without '-' (and without a `_profileId` suffix): the key shared with GA4. */
export function accountKeyOf(account: string): string {
  const s = String(account ?? '').trim();
  const cut = s.indexOf('_');
  return (cut >= 0 ? s.slice(0, cut) : s).replace(/-/g, '').toUpperCase();
}

const FREE_RE = /(^|[^a-z])(free|trial)([^a-z]|$)/i;
const AD_FREE_RE = /ad[ -]?free/i;

/** The class of a plan name, with `pid|plan` overrides. */
export function planClassOf(plan: string, pid: string, overrides?: Record<string, PlanClass>): PlanClass {
  const name = String(plan ?? '');
  const override = overrides?.[`${pid}|${name}`];
  if (override === 'paid' || override === 'free' || override === 'unknown') {
    return override;
  }
  if (!name.trim()) {
    return 'unknown';
  }
  return FREE_RE.test(name) && !AD_FREE_RE.test(name) ? 'free' : 'paid';
}

const fnvMix = (h: number, byte: number) => Math.imul(h ^ byte, 0x01000193);
/** The standard FNV-1a offset basis, and a second one for the other half of a 64-bit id. */
const FNV_BASIS = 0x811c9dc5;
const FNV_BASIS_2 = 0x9e3779b9;

/** 32-bit FNV-1a of a string (over its UTF-8 bytes, so other implementations agree). */
export function fnv1a32(text: string, basis = FNV_BASIS): number {
  const s = String(text ?? '');
  let h = basis | 0;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) {
      h = fnvMix(h, c);
    } else if (c < 0x800) {
      h = fnvMix(h, 0xc0 | (c >> 6));
      h = fnvMix(h, 0x80 | (c & 0x3f));
    } else {
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
        const low = s.charCodeAt(i + 1);
        if (low >= 0xdc00 && low < 0xe000) {
          c = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00);
          i++;
          h = fnvMix(h, 0xf0 | (c >> 18));
          h = fnvMix(h, 0x80 | ((c >> 12) & 0x3f));
          h = fnvMix(h, 0x80 | ((c >> 6) & 0x3f));
          h = fnvMix(h, 0x80 | (c & 0x3f));
          continue;
        }
      }
      h = fnvMix(h, 0xe0 | (c >> 12));
      h = fnvMix(h, 0x80 | ((c >> 6) & 0x3f));
      h = fnvMix(h, 0x80 | (c & 0x3f));
    }
  }
  return h >>> 0;
}

/**
 * A 64-bit id as 16 hex characters: two FNV-1a passes with different offset
 * bases. 32 bits alone collide within one export of tens of thousands of jobs.
 */
export function hash64Hex(text: string): string {
  const hex = (h: number) => h.toString(16).padStart(8, '0');
  return hex(fnv1a32(text)) + hex(fnv1a32(text, FNV_BASIS_2));
}

/** ISO 8601 week of a moment, e.g. `2026-W41`: the anchor of a job id outside timing. */
function isoWeek(t: number): string {
  const date = new Date(floorDay(t) * 1000);
  const weekday = (date.getUTCDay() + 6) % 7;
  const thursday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - weekday + 3);
  const year = new Date(thursday).getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const firstThursday = jan4 - (((new Date(jan4).getUTCDay() + 6) % 7) - 3) * DAY * 1000;
  const week = 1 + Math.round((thursday - firstThursday) / (7 * DAY * 1000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// JSON cells (ClickHouse toJSONString): unnamed tuples arrive as arrays, named
// ones as objects, 64-bit numbers may be quoted. A malformed cell is skipped.

function jsonCell(v: unknown): unknown {
  if (v == null || v === '') {
    return null;
  }
  if (typeof v !== 'string') {
    return v;
  }
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function listOf(v: unknown): unknown[] | null {
  if (Array.isArray(v)) {
    return v;
  }
  // Object.values keeps integer-like keys ("1", "2") in ascending order, i.e. tuple order.
  return isRecord(v) ? Object.values(v) : null;
}

const cellText = (v: unknown) => (v == null || typeof v === 'object' ? '' : String(v));

/**
 * A map column (`[[key...], [value...]]`, `{"1": [...], "2": [...]}`, or an
 * object key → value) as key / value pairs.
 */
function forEachPair(cell: unknown, onPair: (key: unknown, value: unknown) => void) {
  const v = jsonCell(cell);
  const parts = listOf(v);
  if (!parts) {
    return;
  }
  const keys = parts.length === 2 ? listOf(parts[0]) : null;
  const values = parts.length === 2 ? listOf(parts[1]) : null;
  if (keys && values) {
    const n = Math.min(keys.length, values.length);
    for (let k = 0; k < n; k++) {
      onPair(keys[k], values[k]);
    }
  } else if (isRecord(v)) {
    for (const [key, value] of Object.entries(v)) {
      onPair(key, value);
    }
  }
}

/** Subscription ends and a moment each (`expiry_seen`, `expired_reports`) into pairs. */
function parseExpirySeen(cell: unknown, out: number[]) {
  forEachPair(cell, (exp, seen) => pushObservation(cellNumber(exp), cellNumber(seen), out));
}

function pushObservation(exp: number, seen: number, out: number[]) {
  // 0 (1970) is the "unknown" sentinel: not an end at all.
  if (Number.isFinite(exp) && Number.isFinite(seen) && exp > 0 && seen > 0) {
    out.push(exp, seen);
  }
}

/** `[[hour, seconds], ...]` (pairs as arrays or objects) into pairs. */
function parseHours(cell: unknown, out: number[]) {
  const entries = listOf(jsonCell(cell));
  if (!entries) {
    return;
  }
  for (const entry of entries) {
    const pair = listOf(entry);
    if (!pair || pair.length < 2) {
      continue;
    }
    const hour = cellNumber(pair[0]);
    const sec = cellNumber(pair[1]);
    if (Number.isInteger(hour) && hour >= 0 && hour < 24 && Number.isFinite(sec) && sec > 0) {
      out.push(hour, sec);
    }
  }
}

// ---------------------------------------------------------------------------
// Day storage

const NUM_KEYS = [
  'events',
  'legacy_events',
  'gated_plays',
  'ungated_plays',
  'watch_all_min',
  'inactive_attempts',
  'last_ts',
  'app_starts',
  'watch_min',
  'live_min',
  'ondemand_min',
  'catchup_min',
  'distinct_content',
  'playbacks',
  'failed_playbacks',
  'buffering_stops',
  'premium_attempts',
  'premium_paid_content',
  'search_sessions',
  'failed_search_sessions',
  'fav_added',
  'fav_removed',
] as const satisfies ReadonlyArray<keyof AccountDayRow>;
type NumKey = (typeof NUM_KEYS)[number];

const STR_KEYS = [
  'plan',
  'platforms',
  'top_err_code',
  'paywall_title',
  'org',
  'sub_id',
  'org_id',
] as const satisfies ReadonlyArray<keyof AccountDayRow>;
type StrKey = (typeof STR_KEYS)[number];

/** Columns of `full` days only. */
interface FullColumns {
  appStarts: Uint16Array;
  watchMin: Float32Array;
  liveMin: Float32Array;
  ondemandMin: Float32Array;
  catchupMin: Float32Array;
  distinct: Uint16Array;
  playbacks: Uint16Array;
  failed: Uint16Array;
  buffering: Uint16Array;
  premium: Uint16Array;
  premiumPaid: Uint16Array;
  search: Uint16Array;
  failedSearch: Uint16Array;
  favAdded: Uint16Array;
  favRemoved: Uint16Array;
  topErr: Int32Array;
  paywallTitle: Int32Array;
  org: Int32Array;
  subscriptionId: Int32Array;
  organisationId: Int32Array;
  /** UTC offset in hours, NaN when unknown. */
  tz: Float32Array;
  /** Top two local watch hours (-1 = none) and their seconds. */
  hourA: Int8Array;
  secA: Float32Array;
  hourB: Int8Array;
  secB: Float32Array;
  /** Seeds of row i at [seedAt[i], seedAt[i + 1]): profile and content ids, seconds. */
  seedAt: Int32Array;
  seedProfile: Int32Array;
  seedContent: Int32Array;
  seedSec: Float32Array;
  /** Refused playbacks of row i at [payAt[i], payAt[i + 1]): `platform|code` string id and count. */
  payAt: Int32Array;
  payKey: Int32Array;
  payCount: Float64Array;
}

/** One held UTC day; every account appears at most once. */
interface DayData {
  day: number;
  level: DayLevel;
  /** Parts of the day read so far ([from, to) each). */
  parts: Array<[number, number]>;
  n: number;
  ids: Int32Array;
  events: Uint32Array;
  legacy: Uint32Array;
  gatedPlays: Uint16Array;
  ungatedPlays: Uint16Array;
  watchAll: Float32Array;
  inactive: Uint16Array;
  lastTs: Uint32Array;
  plan: Int32Array;
  platforms: Int32Array;
  /** Subscription ends of row i at [obsAt[i], obsAt[i + 1]), ordered by first seen. */
  obsAt: Int32Array;
  obsExp: Uint32Array;
  obsSeen: Uint32Array;
  /** Ends of row i still reported after they had passed, at [repAt[i], repAt[i + 1]): end, first report. */
  repAt: Int32Array;
  repExp: Uint32Array;
  repTs: Uint32Array;
  full: FullColumns | null;
}

/** One account-day as values, for the rare merge of two blocks of the same day. */
interface RowRec {
  id: number;
  num: Record<NumKey, number>;
  str: Record<StrKey, number>;
  tz: number;
  obs: number[];
  reps: number[];
  seeds: number[];
  hours: number[];
  /** (`platform|code` string id, count) pairs. */
  pay: number[];
}

/** What the day builder reads: a datasource block, or merged row values. */
interface RowSource {
  readonly length: number;
  readonly full: boolean;
  id(i: number): number;
  num(key: NumKey, i: number): number;
  str(key: StrKey, i: number): number;
  tz(i: number): number;
  obs(i: number, out: number[]): void;
  reps(i: number, out: number[]): void;
  seeds(i: number, out: number[]): void;
  hours(i: number, out: number[]): void;
  pay(i: number, out: number[]): void;
}

function zeroNums(): Record<NumKey, number> {
  return {
    events: 0,
    legacy_events: 0,
    gated_plays: 0,
    ungated_plays: 0,
    watch_all_min: 0,
    inactive_attempts: 0,
    last_ts: 0,
    app_starts: 0,
    watch_min: 0,
    live_min: 0,
    ondemand_min: 0,
    catchup_min: 0,
    distinct_content: 0,
    playbacks: 0,
    failed_playbacks: 0,
    buffering_stops: 0,
    premium_attempts: 0,
    premium_paid_content: 0,
    search_sessions: 0,
    failed_search_sessions: 0,
    fav_added: 0,
    fav_removed: 0,
  };
}

function zeroStrs(): Record<StrKey, number> {
  return { plan: 0, platforms: 0, top_err_code: 0, paywall_title: 0, org: 0, sub_id: 0, org_id: 0 };
}

function newFullColumns(n: number): FullColumns {
  return {
    appStarts: new Uint16Array(n),
    watchMin: new Float32Array(n),
    liveMin: new Float32Array(n),
    ondemandMin: new Float32Array(n),
    catchupMin: new Float32Array(n),
    distinct: new Uint16Array(n),
    playbacks: new Uint16Array(n),
    failed: new Uint16Array(n),
    buffering: new Uint16Array(n),
    premium: new Uint16Array(n),
    premiumPaid: new Uint16Array(n),
    search: new Uint16Array(n),
    failedSearch: new Uint16Array(n),
    favAdded: new Uint16Array(n),
    favRemoved: new Uint16Array(n),
    topErr: new Int32Array(n),
    paywallTitle: new Int32Array(n),
    org: new Int32Array(n),
    subscriptionId: new Int32Array(n),
    organisationId: new Int32Array(n),
    tz: new Float32Array(n),
    hourA: new Int8Array(n),
    secA: new Float32Array(n),
    hourB: new Int8Array(n),
    secB: new Float32Array(n),
    seedAt: new Int32Array(n + 1),
    seedProfile: new Int32Array(0),
    seedContent: new Int32Array(0),
    seedSec: new Float32Array(0),
    payAt: new Int32Array(n + 1),
    payKey: new Int32Array(0),
    payCount: new Float64Array(0),
  };
}

/** Counts of one row per key, summed (two halves of a day may name the same key). */
function appendCounts(pairs: number[], outKey: number[], outCount: number[]) {
  const sums = new Map<number, number>();
  for (let k = 0; k < pairs.length; k += 2) {
    sums.set(pairs[k], (sums.get(pairs[k]) ?? 0) + pairs[k + 1]);
  }
  for (const [key, count] of sums) {
    outKey.push(key);
    outCount.push(count);
  }
}

/** Distinct ends of one row (earliest sighting each), ordered by first seen. */
function appendObservations(pairs: number[], outExp: number[], outSeen: number[]) {
  if (pairs.length === 2) {
    outExp.push(pairs[0]);
    outSeen.push(pairs[1]);
    return;
  }
  const best = new Map<number, number>();
  for (let k = 0; k < pairs.length; k += 2) {
    const seen = best.get(pairs[k]);
    if (seen === undefined || pairs[k + 1] < seen) {
      best.set(pairs[k], pairs[k + 1]);
    }
  }
  const sorted = [...best.entries()].sort((x, y) => x[1] - y[1] || x[0] - y[0]);
  for (const [exp, seen] of sorted) {
    outExp.push(exp);
    outSeen.push(seen);
  }
}

class Interner {
  private readonly index = new Map<string, number>([['', 0]]);
  readonly values: string[] = [''];

  id(value: string): number {
    if (!value) {
      return 0;
    }
    let id = this.index.get(value);
    if (id === undefined) {
      id = this.values.length;
      this.values.push(value);
      this.index.set(value, id);
    }
    return id;
  }
}

// ---------------------------------------------------------------------------
// Evaluation state

interface WindowAcc {
  activeDays: Float64Array;
  /** Active days with full data (content and error columns). */
  fullDays: Float64Array;
  events: Float64Array;
  legacyEvents: Float64Array;
  gatedPlays: Float64Array;
  ungatedPlays: Float64Array;
  watchAllMin: Float64Array;
  watchMin: Float64Array;
  liveMin: Float64Array;
  ondemandMin: Float64Array;
  catchupMin: Float64Array;
  distinctSum: Float64Array;
  playbacks: Float64Array;
  failedPlaybacks: Float64Array;
  failedDays: Float64Array;
  bufferingStops: Float64Array;
  inactiveAttempts: Float64Array;
  premiumAttempts: Float64Array;
  premiumPaidContent: Float64Array;
  searchSessions: Float64Array;
  failedSearchSessions: Float64Array;
  favAdded: Float64Array;
  favRemoved: Float64Array;
  appStarts: Float64Array;
}

function newWindow(n: number): WindowAcc {
  return {
    activeDays: new Float64Array(n),
    fullDays: new Float64Array(n),
    events: new Float64Array(n),
    legacyEvents: new Float64Array(n),
    gatedPlays: new Float64Array(n),
    ungatedPlays: new Float64Array(n),
    watchAllMin: new Float64Array(n),
    watchMin: new Float64Array(n),
    liveMin: new Float64Array(n),
    ondemandMin: new Float64Array(n),
    catchupMin: new Float64Array(n),
    distinctSum: new Float64Array(n),
    playbacks: new Float64Array(n),
    failedPlaybacks: new Float64Array(n),
    failedDays: new Float64Array(n),
    bufferingStops: new Float64Array(n),
    inactiveAttempts: new Float64Array(n),
    premiumAttempts: new Float64Array(n),
    premiumPaidContent: new Float64Array(n),
    searchSessions: new Float64Array(n),
    failedSearchSessions: new Float64Array(n),
    favAdded: new Float64Array(n),
    favRemoved: new Float64Array(n),
    appStarts: new Float64Array(n),
  };
}

function windowStats(w: WindowAcc, a: number): WindowStats {
  const fullDays = w.fullDays[a];
  return {
    activeDays: w.activeDays[a],
    events: w.events[a],
    legacyEvents: w.legacyEvents[a],
    gatedPlays: w.gatedPlays[a],
    ungatedPlays: w.ungatedPlays[a],
    watchAllMin: round(w.watchAllMin[a], 1),
    watchMin: round(w.watchMin[a], 1),
    liveMin: round(w.liveMin[a], 1),
    ondemandMin: round(w.ondemandMin[a], 1),
    catchupMin: round(w.catchupMin[a], 1),
    distinctPerDay: fullDays > 0 ? round(w.distinctSum[a] / fullDays, 2) : 0,
    playbacks: w.playbacks[a],
    failedPlaybacks: w.failedPlaybacks[a],
    failedDays: w.failedDays[a],
    bufferingStops: w.bufferingStops[a],
    inactiveAttempts: w.inactiveAttempts[a],
    premiumAttempts: w.premiumAttempts[a],
    premiumPaidContent: w.premiumPaidContent[a],
    searchSessions: w.searchSessions[a],
    failedSearchSessions: w.failedSearchSessions[a],
    favAdded: w.favAdded[a],
    favRemoved: w.favRemoved[a],
    appStarts: w.appStarts[a],
  };
}

/**
 * Everything one pass over the held days found, per account. Arrays are
 * indexed by a dense index of the accounts present in the days evaluated (not
 * by every account the store ever held).
 */
interface Core {
  asOf: number;
  dEnd: number;
  rStart: number;
  bStart: number;
  lookback: number;
  /** Store account id → dense index of this evaluation (-1 = not in its days). */
  local: Int32Array;
  /** Dense index → store account id. */
  ids: Int32Array;
  /** Active in the recent or baseline window. */
  seen: Uint8Array;
  R: WindowAcc;
  B: WindowAcc;
  lastSeen: Float64Array;
  lastDay: Float64Array;
  maxGapB: Float64Array;
  basePlan: Int32Array;
  recentPlan: Int32Array;
  latestPlan: Int32Array;
  org: Int32Array;
  subscriptionId: Int32Array;
  organisationId: Int32Array;
  topErr: Int32Array;
  paywallTitle: Int32Array;
  platforms: Int32Array;
  tz: Float64Array;
  dailyWatch: Float32Array;
  /** Current subscription end, NaN when unknown or no end. */
  expiry: Float64Array;
  noEnd: Uint8Array;
  style: Uint8Array;
  deactAt: Float64Array;
  deactVal: Float64Array;
  /** Highest end of the renewal chain (after deactivations). */
  chainMax: Float64Array;
  /** Per account: each end reported after it had passed → its first such report. */
  reports: Map<number, Map<number, number>>;
  /** Last day with playbacks refused for an inactive subscription (-Infinity = none). */
  lastInactiveDay: Float64Array;
  /** Latest moment known to have a gated event (a device that reports ends), -Infinity = none. */
  lastGatedTs: Float64Array;
  /** Refused playbacks per `platform|code` string id (recent and baseline windows). */
  paywall: Map<number, number>;
  /** Recent days held at full level (seeds exist), and held only at light level. */
  recentFullDays: number;
  recentLightDays: number;
  missingDays: number[];
}

/** Per-account findings of one evaluation (accounts active in the windows only). */
interface Acc {
  /** Dense index into the Core arrays. */
  a: number;
  /** Store account id (name, provider, key). */
  g: number;
  pid: string;
  account: string;
  eligible: boolean;
  ineligibleReason?: 'new' | 'free';
  basePlan: string;
  latestPlan: string;
  planClass: PlanClass;
  expiry: number | null;
  noEnd: boolean;
  style: RenewalStyle;
  deactivatedAt: number | null;
  lastSeen: number;
  daysSince: number;
  quietThreshold: number;
  baseWatchPerDay: number;
  fadeMode: 'watch' | 'active_days' | null;
  rawRatio: number;
  fadeRatio: number | null;
  playsRatio: number;
  stbShift: boolean;
  quiet: boolean;
  fading: boolean;
  expiring: boolean;
  lapsed: boolean;
  lapsedSilent: boolean;
  downgrade: boolean;
  inactive: boolean;
  /** Inactive attempts that count as a risk (not after a void / refund). */
  inactiveRisk: boolean;
  premium: boolean;
  deactivated: boolean;
  tech: boolean;
  techErrors: boolean;
  techBuffering: boolean;
  atRisk: boolean;
  lead: boolean;
  /** Needs seeds and send hours (in a list). */
  listed: boolean;
  coverage: 'full' | 'mixed' | 'legacy_only';
  evidence: Evidence[];
  contentEvidence: number;
  behavior?: BehaviorMetrics;
  seeds: Seed[];
  profileIds: string[];
  peakHour: number | null;
  recEndpoint: KeepJob['recEndpoint'];
  /** The reason before the technical hand-off (backtest groups). */
  baseReason?: KeepReason;
  quietOnly: boolean;
  job?: KeepJob;
}

/** Evidence strength for ordering ("strongest first"). */
function evidenceRank(e: Evidence): number {
  switch (e.code) {
    case 'QUIET':
    case 'LAPSED':
      return 1;
    case 'INACTIVE_ATTEMPTS':
    case 'DOWNGRADE':
      return 0.9;
    case 'FADING':
      return clamp(1 - (e.value ?? 1), 0, 1);
    case 'FADING_PLAYS':
      return clamp(1 - (e.value ?? 1), 0, 1) - 0.01;
    case 'PREMIUM_ATTEMPTS':
      return 0.7;
    case 'RENEWAL_REPURCHASE':
      return 0.6;
    case 'EXPIRING':
      return 0.55;
    case 'TECH_ERRORS':
    case 'TECH_BUFFERING':
    case 'GA4_CRASHES':
    case 'GA4_ERROR_SCREENS':
      return 0.5;
    case 'DEACTIVATED':
    case 'LAPSED_SILENT':
      return 0.45;
    case 'DIVERSITY_DROP':
    case 'FAILED_SEARCH':
    case 'TOP_TITLE_GONE':
    case 'FAVORITES_REMOVED':
      return 0.4;
    case 'GA4_SEARCH_NO_PLAY':
    case 'GA4_BROWSE_NO_PLAY':
      return 0.35;
    default:
      return 0.2;
  }
}

function sortEvidence(list: Evidence[]): Evidence[] {
  return list
    .map((e, i) => ({ e, i, r: evidenceRank(e) }))
    .sort((x, y) => y.r - x.r || x.i - y.i)
    .map((x) => x.e);
}

/** Evidence codes that drive each action, shown first on the job. */
const DRIVERS: Record<string, EvidenceCode[]> = {
  win_back: ['LAPSED', 'INACTIVE_ATTEMPTS'],
  win_back_free: ['DOWNGRADE'],
  upgrade: ['INACTIVE_ATTEMPTS', 'PREMIUM_ATTEMPTS'],
  renewal_campaign: ['EXPIRING', 'RENEWAL_REPURCHASE'],
  content_push: ['QUIET', 'FADING', 'FADING_PLAYS'],
  re_engagement: ['QUIET', 'FADING', 'FADING_PLAYS'],
  support: ['TECH_ERRORS', 'TECH_BUFFERING', 'GA4_CRASHES', 'GA4_ERROR_SCREENS'],
};

function driversFirst(evidence: Evidence[], drivers: EvidenceCode[]): Evidence[] {
  const first = drivers.flatMap((code) => evidence.filter((e) => e.code === code));
  return [...first, ...evidence.filter((e) => !drivers.includes(e.code))];
}

function median(values: number[]): number | undefined {
  if (!values.length) {
    return undefined;
  }
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function tierOf(priority: number): PriorityTier {
  return priority >= 60 ? 'high' : priority >= 35 ? 'medium' : 'low';
}

/** The moment of `localHour` on the same local date as `t`. */
function onLocalDate(t: number, localHour: number, tz: number): number {
  const local = t + tz * HOUR;
  return floorDay(local) + localHour * HOUR - tz * HOUR;
}

/** Seeds (per profile and content, baseline / recent seconds) and watch hours of listed accounts. */
interface ListedDetails {
  seeds: Map<number, Map<number, { profile: number; content: number; b: number; r: number }>>;
  hours: Map<number, Float64Array>;
}

interface GroupTally {
  flagged: number;
  labeled: number;
  censored: number;
  positives: number;
  baseLabeled: number;
  basePositives: number;
  /** Bad outcomes of this group's kind among all eligible accounts (flagged anywhere or not): the recall base. */
  allPositives: number;
}

const newTally = (): GroupTally => ({
  flagged: 0,
  labeled: 0,
  censored: 0,
  positives: 0,
  baseLabeled: 0,
  basePositives: 0,
  allPositives: 0,
});

/** What a backtest carries from one as-of date to the next. */
interface BacktestState {
  asOfDays: number[];
  horizon: number;
  grace: number;
  notBefore: number | undefined;
  tally: Map<OutcomeGroup, GroupTally>;
  /** `pid|account` → as-of day of its last job (cooldown); keys survive a store compaction. */
  lastJob: Map<string, number>;
  suppressed: number;
  done: number;
}

/** Paywall code (`<slot 10>/<slot 11>`) → kind: the paywall definition's codes, or a form still to confirm. */
function paywallKind(code: string): KeepQuality['paywall'][number]['kind'] {
  const cut = code.indexOf('/');
  const ep10 = cut >= 0 ? code.slice(0, cut) : code;
  const ep11 = cut >= 0 ? code.slice(cut + 1) : code;
  if (code.includes('subsctiprionInActive')) {
    return 'inactive';
  }
  if (ep10 === '402' || ep11 === 'AE402' || ep11 === '-103') {
    return 'premium';
  }
  return 'candidate';
}

/**
 * The held days and the interned values. Nothing here depends on the rules,
 * so an engine with other rules can work on the same days (withSettings).
 */
class Store {
  readonly dayMap = new Map<number, DayData>();
  sorted: DayData[] | null = null;
  /** Account ids: `pid|account` → id; per id its pid index and account. */
  readonly accountIds = new Map<string, number>();
  readonly accPid: number[] = [];
  readonly accName: string[] = [];
  readonly accKey: Array<string | undefined> = [];
  readonly pids = new Interner();
  readonly strings = new Interner();
  /** Seed contents: `type\u0000id` → id, with the latest title. */
  readonly contentIds = new Map<string, number>();
  readonly contentType: string[] = [];
  readonly contentCid: string[] = [];
  readonly contentTitle: string[] = [];
  readonly platformUnions = new Map<string, number>();

  /**
   * Forgets the accounts no held day refers to any more, once they are the
   * majority: long backtests over other months would otherwise keep every
   * account ever read. Ids are renumbered in place (old order kept).
   */
  compactAccounts() {
    const total = this.accName.length;
    const used = new Uint8Array(total);
    let count = 0;
    for (const day of this.dayMap.values()) {
      for (let i = 0; i < day.n; i++) {
        if (!used[day.ids[i]]) {
          used[day.ids[i]] = 1;
          count++;
        }
      }
    }
    if (count * 2 >= total) {
      return;
    }
    const next = new Int32Array(total).fill(-1);
    let k = 0;
    for (let g = 0; g < total; g++) {
      if (used[g]) {
        next[g] = k;
        this.accPid[k] = this.accPid[g];
        this.accName[k] = this.accName[g];
        this.accKey[k] = this.accKey[g];
        k++;
      }
    }
    this.accPid.length = k;
    this.accName.length = k;
    this.accKey.length = k;
    for (const [key, g] of this.accountIds) {
      if (next[g] < 0) {
        this.accountIds.delete(key);
      } else {
        this.accountIds.set(key, next[g]);
      }
    }
    for (const day of this.dayMap.values()) {
      for (let i = 0; i < day.n; i++) {
        day.ids[i] = next[day.ids[i]];
      }
    }
  }
}

export class KeepEngine implements KeepEngineApi {
  private readonly overrides: Record<string, PlanClass>;
  private readonly deliveryByPid: Record<string, Delivery>;
  /** Held days and interned values: shared with engines made by withSettings. */
  private store = new Store();
  private behavior = new Map<string, BehaviorMetrics>();
  private behaviorStatus: BehaviorResult | null = null;
  private lastBacktest: BacktestReport | null = null;

  constructor(
    readonly rules: KeepRules,
    options: KeepEngineOptions = {}
  ) {
    this.overrides = options.planClassOverrides ?? {};
    this.deliveryByPid = options.deliveryByPid ?? {};
  }

  /** An engine with other rules / options over the days this one holds (no new reads). */
  withSettings(rules: KeepRules, options: KeepEngineOptions): KeepEngine {
    const engine = new KeepEngine(rules, options);
    engine.store = this.store;
    return engine;
  }

  // -------------------------------------------------------------------------
  // Days

  hasDay(day: number, level: DayLevel): boolean {
    const held = this.store.dayMap.get(day);
    return !!held && covers(held.parts, day) && (level === 'light' || held.level === 'full');
  }

  ingestDay(block: DayBlock): void {
    const day = block.day;
    const from = Number.isFinite(block.from) ? block.from : day;
    const to = Number.isFinite(block.to) ? block.to : day + DAY;
    const data = this.buildDay(day, block.level, [[from, to]], this.blockSource(block));
    const held = this.store.dayMap.get(day);
    if (held && !held.parts.some(([f, t]) => from < t && f < to)) {
      // The other half of a day read in two halves: add it to the first.
      const level: DayLevel = held.level === 'full' && block.level === 'full' ? 'full' : 'light';
      this.store.dayMap.set(day, this.mergeDays([held, data], day, level, [...held.parts, [from, to]]));
    } else {
      // New, or the same part read again: the newer read replaces the day.
      this.store.dayMap.set(day, data);
    }
    this.store.sorted = null;
  }

  evictOutside(from: number, to: number): void {
    for (const day of [...this.store.dayMap.keys()]) {
      if (day < from || day > to) {
        this.store.dayMap.delete(day);
      }
    }
    this.store.sorted = null;
    this.store.compactAccounts();
  }

  /** Accounts the store holds (tests: the store forgets accounts of evicted days). */
  accountCount(): number {
    return this.store.accName.length;
  }

  days(): Array<{ day: number; level: DayLevel; rows: number }> {
    return this.sortedDays().map((d) => ({ day: d.day, level: d.level, rows: d.n }));
  }

  private sortedDays(): DayData[] {
    if (!this.store.sorted) {
      this.store.sorted = [...this.store.dayMap.values()].sort((a, b) => a.day - b.day);
    }
    return this.store.sorted;
  }

  private accountId(pid: string, account: string): number {
    const key = `${pid}|${account}`;
    let id = this.store.accountIds.get(key);
    if (id === undefined) {
      id = this.store.accName.length;
      this.store.accountIds.set(key, id);
      this.store.accPid.push(this.store.pids.id(pid));
      this.store.accName.push(account);
      this.store.accKey.push(undefined);
    }
    return id;
  }

  private accountKey(a: number): string {
    let key = this.store.accKey[a];
    if (key === undefined) {
      key = accountKeyOf(this.store.accName[a]);
      this.store.accKey[a] = key;
    }
    return key;
  }

  private contentId(type: string, cid: string, title: string): number {
    const key = `${type}\u0000${cid}`;
    let id = this.store.contentIds.get(key);
    if (id === undefined) {
      id = this.store.contentCid.length;
      this.store.contentIds.set(key, id);
      this.store.contentType.push(type);
      this.store.contentCid.push(cid);
      this.store.contentTitle.push(title);
    } else if (title) {
      this.store.contentTitle[id] = title;
    }
    return id;
  }

  /** `[[[profile, type, id, title], seconds, error], ...]` into (profile, content, seconds) triples. */
  private parseSeeds(cell: unknown, out: number[]) {
    const entries = listOf(jsonCell(cell));
    if (!entries) {
      return;
    }
    for (const entry of entries) {
      const parts = listOf(entry);
      const item = parts ? listOf(parts[0]) : null;
      if (!parts || !item || item.length < 3) {
        continue;
      }
      const sec = cellNumber(parts[1]);
      const cid = cellText(item[2]);
      if (!cid || !Number.isFinite(sec) || sec <= 0) {
        continue;
      }
      out.push(
        this.store.strings.id(cellText(item[0])),
        this.contentId(cellText(item[1]), cid, cellText(item[3])),
        sec
      );
    }
  }

  private unionPlatforms(a: number, b: number): number {
    if (!a || a === b) {
      return b || a;
    }
    if (!b) {
      return a;
    }
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    let id = this.store.platformUnions.get(key);
    if (id === undefined) {
      const names = new Set([...this.store.strings.values[a].split(','), ...this.store.strings.values[b].split(',')]);
      id = this.store.strings.id([...names].filter(Boolean).sort().join(','));
      this.store.platformUnions.set(key, id);
    }
    return id;
  }

  private blockSource(block: DayBlock): RowSource {
    const full = block.level === 'full';
    const numCols: Partial<Record<NumKey, ArrayLike<unknown>>> = {};
    for (const key of NUM_KEYS) {
      numCols[key] = block.column(key);
    }
    const strCols: Partial<Record<StrKey, ArrayLike<unknown>>> = {};
    for (const key of STR_KEYS) {
      strCols[key] = block.column(key);
    }
    const pid = block.column('pid');
    const account = block.column('account');
    const expiry = block.column('expiry_seen');
    const reports = block.column('expired_reports');
    const seeds = block.column('seeds');
    const hours = block.column('hours');
    const tz = block.column('tz_offset_h');
    const paywall = block.column('paywall_codes');
    const length = Math.max(0, Math.floor(block.length) || 0);
    return {
      length,
      full,
      id: (i) => {
        const p = strAt(pid, i).trim();
        const acc = strAt(account, i).trim();
        return p && acc ? this.accountId(p, acc) : -1;
      },
      num: (key, i) => numAt(numCols[key], i),
      str: (key, i) => this.store.strings.id(strAt(strCols[key], i)),
      tz: (i) => {
        const v = optNumAt(tz, i);
        return Math.abs(v) <= 14 ? v : NaN;
      },
      obs: (i, out) => parseExpirySeen(expiry?.[i], out),
      reps: (i, out) => parseExpirySeen(reports?.[i], out),
      seeds: (i, out) => this.parseSeeds(seeds?.[i], out),
      hours: (i, out) => parseHours(hours?.[i], out),
      pay: (i, out) => this.parsePaywallCodes(paywall?.[i], out),
    };
  }

  /** `[["<platform>|<code>"...], [count...]]` (or an object) into (string id, count) pairs. */
  private parsePaywallCodes(cell: unknown, out: number[]) {
    forEachPair(cell, (key, value) => {
      const name = cellText(key).trim();
      const count = cellNumber(value);
      if (name && Number.isFinite(count) && count > 0) {
        out.push(this.store.strings.id(name), count);
      }
    });
  }

  private buildDay(day: number, level: DayLevel, parts: Array<[number, number]>, src: RowSource): DayData {
    const n = src.length;
    const rowIds = new Int32Array(n);
    const firstRow = new Map<number, number>();
    let m = 0;
    let duplicate = false;
    for (let i = 0; i < n; i++) {
      const id = src.id(i);
      rowIds[i] = id;
      if (id >= 0) {
        if (firstRow.has(id)) {
          duplicate = true;
        } else {
          firstRow.set(id, i);
        }
        m++;
      }
    }
    const isFull = level === 'full' && src.full;
    const ids = new Int32Array(m);
    const events = new Uint32Array(m);
    const legacy = new Uint32Array(m);
    const gatedPlays = new Uint16Array(m);
    const ungatedPlays = new Uint16Array(m);
    const watchAll = new Float32Array(m);
    const inactive = new Uint16Array(m);
    const lastTs = new Uint32Array(m);
    const plan = new Int32Array(m);
    const platforms = new Int32Array(m);
    const obsAt = new Int32Array(m + 1);
    const obsExp: number[] = [];
    const obsSeen: number[] = [];
    const repAt = new Int32Array(m + 1);
    const repExp: number[] = [];
    const repTs: number[] = [];
    const full = isFull ? newFullColumns(m) : null;
    const seedProfile: number[] = [];
    const seedContent: number[] = [];
    const seedSec: number[] = [];
    const payKey: number[] = [];
    const payCount: number[] = [];
    const scratch: number[] = [];

    let r = 0;
    for (let i = 0; i < n; i++) {
      const id = rowIds[i];
      if (id < 0) {
        continue;
      }
      ids[r] = id;
      events[r] = u32(src.num('events', i));
      legacy[r] = u32(src.num('legacy_events', i));
      gatedPlays[r] = u16(src.num('gated_plays', i));
      ungatedPlays[r] = u16(src.num('ungated_plays', i));
      watchAll[r] = src.num('watch_all_min', i);
      inactive[r] = u16(src.num('inactive_attempts', i));
      lastTs[r] = u32(src.num('last_ts', i));
      plan[r] = src.str('plan', i);
      platforms[r] = src.str('platforms', i);
      scratch.length = 0;
      src.obs(i, scratch);
      if (scratch.length) {
        appendObservations(scratch, obsExp, obsSeen);
      }
      obsAt[r + 1] = obsExp.length;
      scratch.length = 0;
      src.reps(i, scratch);
      if (scratch.length) {
        // The earliest report of each end (two halves of a day: the first half's).
        appendObservations(scratch, repExp, repTs);
      }
      repAt[r + 1] = repExp.length;

      if (full) {
        full.appStarts[r] = u16(src.num('app_starts', i));
        full.watchMin[r] = src.num('watch_min', i);
        full.liveMin[r] = src.num('live_min', i);
        full.ondemandMin[r] = src.num('ondemand_min', i);
        full.catchupMin[r] = src.num('catchup_min', i);
        full.distinct[r] = u16(src.num('distinct_content', i));
        full.playbacks[r] = u16(src.num('playbacks', i));
        full.failed[r] = u16(src.num('failed_playbacks', i));
        full.buffering[r] = u16(src.num('buffering_stops', i));
        full.premium[r] = u16(src.num('premium_attempts', i));
        full.premiumPaid[r] = u16(src.num('premium_paid_content', i));
        full.search[r] = u16(src.num('search_sessions', i));
        full.failedSearch[r] = u16(src.num('failed_search_sessions', i));
        full.favAdded[r] = u16(src.num('fav_added', i));
        full.favRemoved[r] = u16(src.num('fav_removed', i));
        full.topErr[r] = src.str('top_err_code', i);
        full.paywallTitle[r] = src.str('paywall_title', i);
        full.org[r] = src.str('org', i);
        full.subscriptionId[r] = src.str('sub_id', i);
        full.organisationId[r] = src.str('org_id', i);
        full.tz[r] = src.tz(i);

        scratch.length = 0;
        src.seeds(i, scratch);
        if (scratch.length) {
          appendSeeds(scratch, seedProfile, seedContent, seedSec);
        }
        full.seedAt[r + 1] = seedSec.length;

        scratch.length = 0;
        src.hours(i, scratch);
        const [hA, sA, hB, sB] = topHours(scratch);
        full.hourA[r] = hA;
        full.secA[r] = sA;
        full.hourB[r] = hB;
        full.secB[r] = sB;

        scratch.length = 0;
        src.pay(i, scratch);
        if (scratch.length) {
          appendCounts(scratch, payKey, payCount);
        }
        full.payAt[r + 1] = payKey.length;
      }
      r++;
    }
    if (full) {
      full.seedProfile = Int32Array.from(seedProfile);
      full.seedContent = Int32Array.from(seedContent);
      full.seedSec = Float32Array.from(seedSec);
      full.payKey = Int32Array.from(payKey);
      full.payCount = Float64Array.from(payCount);
    }
    const data: DayData = {
      day,
      level: isFull ? 'full' : 'light',
      parts,
      n: m,
      ids,
      events,
      legacy,
      gatedPlays,
      ungatedPlays,
      watchAll,
      inactive,
      lastTs,
      plan,
      platforms,
      obsAt,
      obsExp: Uint32Array.from(obsExp, u32),
      obsSeen: Uint32Array.from(obsSeen, u32),
      repAt,
      repExp: Uint32Array.from(repExp, u32),
      repTs: Uint32Array.from(repTs, u32),
      full,
    };
    // A block should hold each account once; if not, its rows are added up
    // like two halves, so the day is never counted twice.
    return duplicate ? this.mergeDays([data], day, data.level, parts) : data;
  }

  private decodeRow(d: DayData, i: number): RowRec {
    const num = zeroNums();
    num.events = d.events[i];
    num.legacy_events = d.legacy[i];
    num.gated_plays = d.gatedPlays[i];
    num.ungated_plays = d.ungatedPlays[i];
    num.watch_all_min = d.watchAll[i];
    num.inactive_attempts = d.inactive[i];
    num.last_ts = d.lastTs[i];
    const str = zeroStrs();
    str.plan = d.plan[i];
    str.platforms = d.platforms[i];
    const obs: number[] = [];
    for (let j = d.obsAt[i]; j < d.obsAt[i + 1]; j++) {
      obs.push(d.obsExp[j], d.obsSeen[j]);
    }
    const reps: number[] = [];
    for (let j = d.repAt[i]; j < d.repAt[i + 1]; j++) {
      reps.push(d.repExp[j], d.repTs[j]);
    }
    const rec: RowRec = { id: d.ids[i], num, str, tz: NaN, obs, reps, seeds: [], hours: [], pay: [] };
    const f = d.full;
    if (f) {
      num.app_starts = f.appStarts[i];
      num.watch_min = f.watchMin[i];
      num.live_min = f.liveMin[i];
      num.ondemand_min = f.ondemandMin[i];
      num.catchup_min = f.catchupMin[i];
      num.distinct_content = f.distinct[i];
      num.playbacks = f.playbacks[i];
      num.failed_playbacks = f.failed[i];
      num.buffering_stops = f.buffering[i];
      num.premium_attempts = f.premium[i];
      num.premium_paid_content = f.premiumPaid[i];
      num.search_sessions = f.search[i];
      num.failed_search_sessions = f.failedSearch[i];
      num.fav_added = f.favAdded[i];
      num.fav_removed = f.favRemoved[i];
      str.top_err_code = f.topErr[i];
      str.paywall_title = f.paywallTitle[i];
      str.org = f.org[i];
      str.sub_id = f.subscriptionId[i];
      str.org_id = f.organisationId[i];
      rec.tz = f.tz[i];
      for (let j = f.seedAt[i]; j < f.seedAt[i + 1]; j++) {
        rec.seeds.push(f.seedProfile[j], f.seedContent[j], f.seedSec[j]);
      }
      if (f.hourA[i] >= 0) {
        rec.hours.push(f.hourA[i], f.secA[i]);
      }
      if (f.hourB[i] >= 0) {
        rec.hours.push(f.hourB[i], f.secB[i]);
      }
      for (let j = f.payAt[i]; j < f.payAt[i + 1]; j++) {
        rec.pay.push(f.payKey[j], f.payCount[j]);
      }
    }
    return rec;
  }

  /** Adds up rows of the same account: sums add, uniq counts add (an upper bound), the later row names the plan. */
  private combine(into: RowRec, other: RowRec) {
    const later = other.num.last_ts > into.num.last_ts;
    for (const key of NUM_KEYS) {
      if (key === 'last_ts') {
        into.num.last_ts = Math.max(into.num.last_ts, other.num.last_ts);
      } else {
        into.num[key] += other.num[key];
      }
    }
    for (const key of STR_KEYS) {
      if (key === 'platforms') {
        into.str.platforms = this.unionPlatforms(into.str.platforms, other.str.platforms);
      } else if (other.str[key] && (later || !into.str[key])) {
        into.str[key] = other.str[key];
      }
    }
    if (!Number.isNaN(other.tz) && (later || Number.isNaN(into.tz))) {
      into.tz = other.tz;
    }
    into.obs.push(...other.obs);
    into.reps.push(...other.reps);
    into.seeds.push(...other.seeds);
    into.hours.push(...other.hours);
    into.pay.push(...other.pay);
  }

  private mergeDays(held: DayData[], day: number, level: DayLevel, ranges: Array<[number, number]>): DayData {
    const byId = new Map<number, RowRec>();
    const rows: RowRec[] = [];
    for (const d of held) {
      for (let i = 0; i < d.n; i++) {
        const rec = this.decodeRow(d, i);
        const held = byId.get(rec.id);
        if (held) {
          this.combine(held, rec);
        } else {
          byId.set(rec.id, rec);
          rows.push(rec);
        }
      }
    }
    const full = level === 'full' && held.every((d) => d.full !== null);
    const src: RowSource = {
      length: rows.length,
      full,
      id: (i) => rows[i].id,
      num: (key, i) => rows[i].num[key],
      str: (key, i) => rows[i].str[key],
      tz: (i) => rows[i].tz,
      obs: (i, out) => out.push(...rows[i].obs),
      reps: (i, out) => out.push(...rows[i].reps),
      seeds: (i, out) => out.push(...rows[i].seeds),
      hours: (i, out) => out.push(...rows[i].hours),
      pay: (i, out) => out.push(...rows[i].pay),
    };
    return this.buildDay(day, full ? 'full' : 'light', ranges, src);
  }

  // -------------------------------------------------------------------------
  // GA4 evidence

  setBehavior(result: BehaviorResult | null): void {
    this.behavior = new Map();
    this.behaviorStatus = result;
    for (const row of result?.rows ?? []) {
      if (!row || !row.pid || !row.account) {
        continue;
      }
      const metrics: BehaviorMetrics = {
        days: row.days,
        sessions: row.sessions,
        engagementMin: row.engagementMin,
        searchSessions: row.searchSessions,
        searchNoPlaySessions: row.searchNoPlaySessions,
        browseNoPlaySessions: row.browseNoPlaySessions,
        crashes: row.crashes,
        crashDays: row.crashDays,
        errorScreenSessions: row.errorScreenSessions,
        noInternetSessions: row.noInternetSessions,
        accountVisits: row.accountVisits,
        logoutClicks: row.logoutClicks,
        myListAdds: row.myListAdds,
        myListRemoves: row.myListRemoves,
        platforms: Array.isArray(row.platforms) ? row.platforms : [],
      };
      this.behavior.set(`${row.pid}|${accountKeyOf(row.account)}`, metrics);
    }
  }

  // -------------------------------------------------------------------------
  // Evaluation

  evaluate(asOf: number, opts: EvaluateOptions = {}): KeepSnapshot {
    const core = this.core(floorDay(asOf));
    const floor = sendFloor(core.dEnd, opts.notBefore);
    const accs = this.assess(core, true);
    const jobs: KeepJob[] = [];
    for (const acc of accs) {
      if (acc.atRisk) {
        const job = this.decide(core, acc, floor);
        if (job) {
          acc.job = job;
          jobs.push(job);
        }
      }
    }
    this.applyHoldoutAndCapacity(jobs);
    jobs.sort((x, y) => y.priority - x.priority || compareText(x.id, y.id));

    const assessments: AccountAssessment[] = [];
    const renewals: RenewalItem[] = [];
    const leads: AccountAssessment[] = [];
    const support: AccountAssessment[] = [];
    for (const acc of accs) {
      const assessment = this.toAssessment(core, acc);
      assessments.push(assessment);
      if (!acc.eligible) {
        continue;
      }
      if (acc.expiring && acc.expiry !== null) {
        renewals.push({
          key: assessment.key,
          pid: acc.pid,
          account: acc.account,
          expiry: acc.expiry,
          renewalStyle: acc.style,
          atRisk: acc.atRisk,
          kind: acc.atRisk ? 'at_risk' : 'check_autopay',
          plan: acc.latestPlan,
        });
      } else if (acc.lapsedSilent && acc.expiry !== null) {
        renewals.push({
          key: assessment.key,
          pid: acc.pid,
          account: acc.account,
          expiry: acc.expiry,
          renewalStyle: acc.style,
          atRisk: acc.atRisk,
          kind: 'expired_silent',
          plan: acc.latestPlan,
        });
      }
      if (acc.lead) {
        leads.push(assessment);
      }
      if (acc.tech || acc.deactivated) {
        support.push(assessment);
      }
    }
    renewals.sort((x, y) => x.expiry - y.expiry);
    // The lists are cut for display: the worst cases first.
    support.sort(supportOrder);
    leads.sort((x, y) => leadStrength(y) - leadStrength(x) || compareText(x.key, y.key));

    const pids = [...new Set(accs.map((acc) => acc.pid))].sort();
    return {
      asOf: core.asOf,
      pids,
      assessments,
      jobs,
      renewals,
      leads,
      support,
      quality: this.quality(core, accs),
      mdePct: this.mde(jobs),
    };
  }

  /** One linear pass over the held days up to the as-of day into per-account accumulators. */
  private core(D: number): Core {
    const r = this.rules;
    const recentDays = ruleDays(r.recentDays);
    const baselineDays = ruleDays(r.baselineDays);
    const historyDays = ruleDays(r.renewalHistoryDays);
    const dEnd = D + DAY;
    const rStart = D - (recentDays - 1) * DAY;
    const bStart = rStart - baselineDays * DAY;
    const hStart = D - (historyDays - 1) * DAY;
    const from = Math.min(bStart, hStart);
    const L = recentDays + baselineDays;

    // Dense index of the accounts present in the days evaluated (in store
    // order): everything below is sized by them, not by every account held.
    const windowDays = this.sortedDays().filter((day) => day.day >= from && day.day <= D);
    const local = new Int32Array(this.store.accName.length).fill(-1);
    let n = 0;
    for (const day of windowDays) {
      for (let i = 0; i < day.n; i++) {
        if (local[day.ids[i]] < 0) {
          local[day.ids[i]] = 0;
          n++;
        }
      }
    }
    const ids = new Int32Array(n);
    for (let g = 0, k = 0; g < local.length; g++) {
      if (local[g] >= 0) {
        local[g] = k;
        ids[k++] = g;
      }
    }

    const seen = new Uint8Array(n);
    const R = newWindow(n);
    const B = newWindow(n);
    const lastSeen = new Float64Array(n);
    const lastDay = new Float64Array(n);
    const prevB = new Float64Array(n);
    const maxGapB = new Float64Array(n);
    const basePlan = new Int32Array(n);
    const recentPlan = new Int32Array(n);
    const latestPlan = new Int32Array(n);
    const org = new Int32Array(n);
    const subscriptionId = new Int32Array(n);
    const organisationId = new Int32Array(n);
    const topErr = new Int32Array(n);
    const paywallTitle = new Int32Array(n);
    const platforms = new Int32Array(n);
    const tz = new Float64Array(n).fill(NaN);
    const dailyWatch = new Float32Array(n * L);
    const paywall = new Map<number, number>();
    const reports = new Map<number, Map<number, number>>();
    const lastInactiveDay = new Float64Array(n).fill(-Infinity);
    const lastGatedTs = new Float64Array(n).fill(-Infinity);

    // Renewal chain (see the expiry rules): the highest end so far, the
    // distinct ends seen, how the last forward move happened, deactivations.
    const chainMax = new Float64Array(n).fill(NaN);
    const chainDay = new Float64Array(n).fill(NaN);
    const firstEnd = new Float64Array(n).fill(NaN);
    const moreEnds = new Map<number, number[]>();
    const style = new Uint8Array(n);
    const deactAt = new Float64Array(n).fill(NaN);
    const deactVal = new Float64Array(n).fill(NaN);
    const noEndSeen = new Uint8Array(n);
    // Ends seen on the last two active days.
    const day1 = new Float64Array(n);
    const max1 = new Float64Array(n).fill(NaN);
    const noEnd1 = new Uint8Array(n);
    const max2 = new Float64Array(n).fill(NaN);
    const noEnd2 = new Uint8Array(n);

    let recentFullDays = 0;
    let recentLightDays = 0;
    const missingDays: number[] = [];
    for (let d = from; d <= D; d += DAY) {
      if (!this.hasDay(d, d >= bStart ? 'full' : 'light')) {
        missingDays.push(d);
      }
      if (d >= rStart && this.hasDay(d, 'full')) {
        recentFullDays++;
      } else if (d >= rStart && this.hasDay(d, 'light')) {
        recentLightDays++;
      }
    }

    for (const day of windowDays) {
      const d = day.day;
      const inR = d >= rStart;
      const inW = d >= bStart;
      const inH = d >= hStart;
      const w = inR ? R : B;
      const li = (d - bStart) / DAY;
      const f = day.full;
      for (let i = 0; i < day.n; i++) {
        const a = local[day.ids[i]];
        if (day.lastTs[i] > lastSeen[a]) {
          lastSeen[a] = day.lastTs[i];
        }
        if (d > lastDay[a]) {
          lastDay[a] = d;
        }
        // Evidence that a subscription end really passed (see LAPSED).
        if (day.inactive[i] > 0) {
          lastInactiveDay[a] = d;
        }
        if (day.events[i] > day.legacy[i]) {
          // Only gated events: the last event is one; mixed: one at some moment of the day.
          const t = day.legacy[i] === 0 ? Math.max(day.lastTs[i], d) : d;
          if (t > lastGatedTs[a]) {
            lastGatedTs[a] = t;
          }
        }
        for (let j = day.repAt[i]; j < day.repAt[i + 1]; j++) {
          let byEnd = reports.get(a);
          if (!byEnd) {
            byEnd = new Map();
            reports.set(a, byEnd);
          }
          const held = byEnd.get(day.repExp[j]);
          if (held === undefined || day.repTs[j] < held) {
            byEnd.set(day.repExp[j], day.repTs[j]);
          }
        }

        if (inW) {
          seen[a] = 1;
          w.activeDays[a]++;
          w.events[a] += day.events[i];
          w.legacyEvents[a] += day.legacy[i];
          w.gatedPlays[a] += day.gatedPlays[i];
          w.ungatedPlays[a] += day.ungatedPlays[i];
          w.watchAllMin[a] += day.watchAll[i];
          w.inactiveAttempts[a] += day.inactive[i];
          dailyWatch[a * L + li] += day.watchAll[i];
          const p = day.plan[i];
          if (p) {
            if (inR) {
              recentPlan[a] = p;
            } else {
              basePlan[a] = p;
            }
            latestPlan[a] = p;
          }
          const pf = day.platforms[i];
          if (pf && pf !== platforms[a]) {
            platforms[a] = this.unionPlatforms(platforms[a], pf);
          }
          if (!inR) {
            if (prevB[a] > 0) {
              const gap = (d - prevB[a]) / DAY;
              if (gap > maxGapB[a]) {
                maxGapB[a] = gap;
              }
            }
            prevB[a] = d;
          }
          // Light rows have no content or error columns: those stay missing
          // (fullDays counts the days that have them), never zero activity.
          if (f) {
            w.fullDays[a]++;
            w.watchMin[a] += f.watchMin[i];
            w.liveMin[a] += f.liveMin[i];
            w.ondemandMin[a] += f.ondemandMin[i];
            w.catchupMin[a] += f.catchupMin[i];
            w.distinctSum[a] += f.distinct[i];
            w.playbacks[a] += f.playbacks[i];
            w.failedPlaybacks[a] += f.failed[i];
            if (f.failed[i] > 0) {
              w.failedDays[a]++;
            }
            w.bufferingStops[a] += f.buffering[i];
            w.premiumAttempts[a] += f.premium[i];
            w.premiumPaidContent[a] += f.premiumPaid[i];
            w.searchSessions[a] += f.search[i];
            w.failedSearchSessions[a] += f.failedSearch[i];
            w.favAdded[a] += f.favAdded[i];
            w.favRemoved[a] += f.favRemoved[i];
            w.appStarts[a] += f.appStarts[i];
            if (f.org[i]) {
              org[a] = f.org[i];
            }
            if (f.subscriptionId[i]) {
              subscriptionId[a] = f.subscriptionId[i];
            }
            if (f.organisationId[i]) {
              organisationId[a] = f.organisationId[i];
            }
            if (inR && f.topErr[i]) {
              topErr[a] = f.topErr[i];
            }
            if (inR && f.paywallTitle[i]) {
              paywallTitle[a] = f.paywallTitle[i];
            }
            if (!Number.isNaN(f.tz[i])) {
              tz[a] = f.tz[i];
            }
            for (let j = f.payAt[i]; j < f.payAt[i + 1]; j++) {
              paywall.set(f.payKey[j], (paywall.get(f.payKey[j]) ?? 0) + f.payCount[j]);
            }
          }
        }

        if (inH) {
          if (d !== day1[a]) {
            max2[a] = max1[a];
            noEnd2[a] = noEnd1[a];
            day1[a] = d;
            max1[a] = NaN;
            noEnd1[a] = 0;
          }
          for (let j = day.obsAt[i]; j < day.obsAt[i + 1]; j++) {
            const end = day.obsExp[j];
            const seenAt = day.obsSeen[j];
            if (end >= NO_END_SEC) {
              noEnd1[a] = 1;
              noEndSeen[a] = 1;
              continue;
            }
            if (!(end <= max1[a])) {
              max1[a] = end;
            }
            // Only the first sighting of an end counts: a value seen again
            // later is a device still caching it, not a new event.
            if (end === firstEnd[a]) {
              continue;
            }
            if (Number.isNaN(firstEnd[a])) {
              firstEnd[a] = end;
            } else {
              const more = moreEnds.get(a);
              if (more?.includes(end)) {
                continue;
              }
              if (more) {
                more.push(end);
              } else {
                moreEnds.set(a, [end]);
              }
            }
            const old = chainMax[a];
            if (Number.isNaN(old)) {
              chainMax[a] = end;
              chainDay[a] = d;
            } else if (end > old) {
              // Ends first seen on the chain's first day arrive in no telling
              // order (a device's stale value next to the current one): the
              // highest one starts the chain, without a renewal style.
              if (d !== chainDay[a]) {
                const tod = Math.abs(mod(end - old + DAY / 2, DAY) - DAY / 2);
                // The old end itself was still reported after it had passed,
                // before the new one appeared: it ran out, then a new purchase.
                // Reports of other ends (a second device's stale value) or
                // after the new end appeared say nothing about this renewal.
                const reported = reports.get(a)?.get(old);
                const expiredBetween = reported !== undefined && reported < seenAt - RENEWAL_REFRESH_SLACK_SEC;
                if (tod <= TIME_OF_DAY_SLACK_SEC && !expiredBetween) {
                  style[a] = seenAt < old - EARLY_RENEWAL_SEC ? STYLE_EARLY : STYLE_AT_TERM;
                } else {
                  style[a] = STYLE_REPURCHASE;
                }
              }
              chainMax[a] = end;
            } else if (Math.abs(end - seenAt) <= DEACTIVATION_SLACK_SEC) {
              deactAt[a] = seenAt;
              deactVal[a] = end;
              chainMax[a] = end;
            }
            // Any other earlier end is a stale cache of another device: ignored.
          }
        }
      }
    }

    // Current end: the highest end of the last two active days (a second
    // device may still show an old one), never above the renewal chain (so an
    // end that a deactivation replaced does not come back); else the chain.
    const expiry = new Float64Array(n).fill(NaN);
    const noEnd = new Uint8Array(n);
    for (let a = 0; a < n; a++) {
      if (noEnd1[a] || noEnd2[a]) {
        noEnd[a] = 1;
        continue;
      }
      const recentMax = Number.isNaN(max1[a]) ? max2[a] : Number.isNaN(max2[a]) ? max1[a] : Math.max(max1[a], max2[a]);
      if (!Number.isNaN(recentMax)) {
        expiry[a] = Number.isNaN(chainMax[a]) ? recentMax : Math.min(recentMax, chainMax[a]);
      } else if (!Number.isNaN(chainMax[a])) {
        expiry[a] = chainMax[a];
      } else if (noEndSeen[a]) {
        noEnd[a] = 1;
      }
    }

    return {
      asOf: D,
      dEnd,
      rStart,
      bStart,
      lookback: L,
      local,
      ids,
      seen,
      R,
      B,
      lastSeen,
      lastDay,
      maxGapB,
      basePlan,
      recentPlan,
      latestPlan,
      org,
      subscriptionId,
      organisationId,
      topErr,
      paywallTitle,
      platforms,
      tz,
      dailyWatch,
      expiry,
      noEnd,
      style,
      deactAt,
      deactVal,
      chainMax,
      reports,
      lastInactiveDay,
      lastGatedTs,
      paywall,
      recentFullDays,
      recentLightDays,
      missingDays,
    };
  }

  /** The rules per account active in the windows. */
  private assess(c: Core, useBehavior: boolean): Acc[] {
    const r = this.rules;
    const recentDays = ruleDays(r.recentDays);
    const baselineDays = ruleDays(r.baselineDays);
    const { R, B } = c;
    const accs: Acc[] = [];
    const ratiosByPid = new Map<string, number[]>();

    for (let a = 0; a < c.seen.length; a++) {
      if (!c.seen[a]) {
        continue;
      }
      const g = c.ids[a];
      const pid = this.store.pids.values[this.store.accPid[g]];
      const account = this.store.accName[g];
      const basePlan = this.store.strings.values[c.basePlan[a] || c.recentPlan[a]];
      const latestPlan = this.store.strings.values[c.latestPlan[a]] || basePlan;
      const planClass = planClassOf(basePlan, pid, this.overrides);
      const ineligibleReason: Acc['ineligibleReason'] =
        B.activeDays[a] < r.minBaselineActiveDays
          ? 'new'
          : planClass === 'free' && !r.includeFreePlans
            ? 'free'
            : undefined;
      const events = R.events[a] + B.events[a];
      const legacy = R.legacyEvents[a] + B.legacyEvents[a];
      const noEnd = c.noEnd[a] === 1;
      const expiry = Number.isNaN(c.expiry[a]) ? null : c.expiry[a];
      const acc: Acc = {
        a,
        g,
        pid,
        account,
        eligible: !ineligibleReason,
        ineligibleReason,
        basePlan,
        latestPlan,
        planClass,
        expiry,
        noEnd,
        style: STYLES[c.style[a]],
        deactivatedAt: Number.isNaN(c.deactAt[a]) ? null : c.deactAt[a],
        lastSeen: c.lastSeen[a],
        daysSince: Math.round((c.asOf - c.lastDay[a]) / DAY),
        quietThreshold: Math.max(r.quietDays, Math.ceil(r.quietGapFactor * c.maxGapB[a])),
        baseWatchPerDay: B.watchAllMin[a] / baselineDays,
        fadeMode: null,
        rawRatio: NaN,
        fadeRatio: null,
        playsRatio: NaN,
        stbShift: false,
        quiet: false,
        fading: false,
        expiring: false,
        lapsed: false,
        lapsedSilent: false,
        downgrade: false,
        inactive: false,
        inactiveRisk: false,
        premium: false,
        deactivated: false,
        tech: false,
        techErrors: false,
        techBuffering: false,
        atRisk: false,
        lead: false,
        listed: false,
        coverage: legacy <= 0 ? 'full' : legacy >= events ? 'legacy_only' : 'mixed',
        evidence: [],
        contentEvidence: 0,
        seeds: [],
        profileIds: [],
        peakHour: null,
        recEndpoint: 'tvchannels',
        quietOnly: false,
      };
      accs.push(acc);
      if (!acc.eligible) {
        continue;
      }
      if (B.watchAllMin[a] <= 0) {
        if (B.activeDays[a] <= 0) {
          continue;
        }
        // No watch time to compare (set-top boxes and old builds report none).
        acc.fadeMode = 'active_days';
        acc.rawRatio = R.activeDays[a] / recentDays / (B.activeDays[a] / baselineDays);
      } else if (acc.baseWatchPerDay >= r.minBaselineWatchMin) {
        acc.fadeMode = 'watch';
        acc.rawRatio = R.watchAllMin[a] / recentDays / acc.baseWatchPerDay;
        const list = ratiosByPid.get(pid);
        if (list) {
          list.push(acc.rawRatio);
        } else {
          ratiosByPid.set(pid, [acc.rawRatio]);
        }
      }
    }

    // A season, a holiday or an outage moves everybody: fading is judged
    // against the provider's own median ratio on the same day.
    const pidMedian = new Map<string, number>();
    for (const [pid, ratios] of ratiosByPid) {
      pidMedian.set(pid, clamp(median(ratios) ?? 1, 0.5, 1.5));
    }

    for (const acc of accs) {
      if (acc.eligible) {
        this.signals(c, acc, pidMedian.get(acc.pid) ?? 1, useBehavior);
      }
    }

    // Seeds and send hours only for the accounts that end up in a list.
    const need = new Uint8Array(c.seen.length);
    for (const acc of accs) {
      if (acc.listed) {
        need[acc.a] = 1;
      }
    }
    const extra = this.listedDetails(c, need);
    for (const acc of accs) {
      if (acc.listed) {
        this.details(c, acc, extra);
      }
    }
    return accs;
  }

  private signals(c: Core, acc: Acc, pidMedian: number, useBehavior: boolean) {
    const r = this.rules;
    const recentDays = ruleDays(r.recentDays);
    const baselineDays = ruleDays(r.baselineDays);
    const R = c.R;
    const B = c.B;
    const dEnd = c.dEnd;
    const a = acc.a;
    const ev: Evidence[] = [];

    if (useBehavior && this.behavior.size) {
      acc.behavior = this.behavior.get(`${acc.pid}|${this.accountKey(acc.g)}`);
    }
    const ga4 = acc.behavior;

    acc.quiet = acc.daysSince >= acc.quietThreshold;
    if (acc.quiet) {
      ev.push({ code: 'QUIET', value: acc.daysSince, ref: acc.quietThreshold });
    }

    if (acc.fadeMode === 'watch') {
      acc.fadeRatio = round(acc.rawRatio / pidMedian);
      const playsR = R.gatedPlays[a] + R.ungatedPlays[a];
      const playsB = B.gatedPlays[a] + B.ungatedPlays[a];
      const shareR = playsR > 0 ? R.ungatedPlays[a] / playsR : 0;
      const shareB = playsB > 0 ? B.ungatedPlays[a] / playsB : 0;
      acc.stbShift = shareR - shareB > r.stbShiftShare;
      acc.playsRatio = playsB > 0 ? playsR / recentDays / (playsB / baselineDays) : playsR > 0 ? Infinity : 0;
      acc.fading = acc.fadeRatio <= r.fadeShare && (!acc.stbShift || acc.playsRatio <= r.fadeShare);
      if (acc.fading) {
        ev.push({ code: 'FADING', value: acc.fadeRatio, ref: round(acc.baseWatchPerDay, 1) });
        if (acc.stbShift) {
          ev.push({ code: 'FADING_PLAYS', value: round(acc.playsRatio) });
        }
      }
    } else if (acc.fadeMode === 'active_days') {
      acc.fadeRatio = round(acc.rawRatio);
      acc.fading = acc.fadeRatio <= r.fadeShare;
      if (acc.fading) {
        ev.push({ code: 'FADING_PLAYS', value: acc.fadeRatio, ref: round(B.activeDays[a] / baselineDays) });
      }
    }
    const fq = acc.fading || acc.quiet;

    const expiry = acc.expiry;
    const deactivatedInWindow = acc.deactivatedAt !== null && acc.deactivatedAt >= c.bStart && acc.deactivatedAt < dEnd;
    // The current end came from a void / refund / admin action: support only,
    // no offers. A purchase after it moves the chain past the voided end, and
    // the customer is one to keep again.
    const endIsDeactivation = deactivatedInWindow && expiry !== null && expiry === c.deactVal[a];
    acc.deactivated = endIsDeactivation;
    if (deactivatedInWindow && acc.deactivatedAt !== null) {
      ev.push({ code: 'DEACTIVATED', value: acc.deactivatedAt });
    }
    if (expiry !== null) {
      const left = expiry - dEnd;
      acc.expiring = left >= 0 && left <= r.renewalWindowDays * DAY;
      if (acc.expiring) {
        ev.push({ code: 'EXPIRING', value: round(left / DAY, 1), label: acc.style });
        if (acc.style === 'repurchase') {
          ev.push({ code: 'RENEWAL_REPURCHASE' });
        }
      }
      const since = dEnd - expiry;
      if (since > 0 && since <= r.lapsedDays * DAY && !endIsDeactivation) {
        const pastGrace = since >= r.lapsedGraceDays * DAY || R.inactiveAttempts[a] > 0;
        // A device that reports ends saw this one pass: the end was still
        // reported after it had passed, playbacks were refused after it, or
        // such a device was used after it. Activity on set-top boxes alone
        // (they report no end) under an end left over from the renewal chain
        // proves nothing: that customer may well have renewed, so no offer —
        // listed like an expired and silent one, to check in the CRM.
        const passedSeen =
          c.reports.get(a)?.has(expiry) === true || c.lastInactiveDay[a] + DAY > expiry || c.lastGatedTs[a] > expiry;
        // An end below the top of the renewal chain is a device that has not
        // refreshed yet (the renewal was already seen): never a lapse.
        const superseded = c.chainMax[a] > expiry;
        if (pastGrace && acc.lastSeen > expiry && passedSeen && !superseded) {
          acc.lapsed = true;
          ev.push({ code: 'LAPSED', value: round(since / DAY, 1) });
        } else if (pastGrace) {
          acc.lapsedSilent = true;
          ev.push({ code: 'LAPSED_SILENT', value: round(since / DAY, 1) });
        }
      }
    }

    acc.downgrade = acc.planClass === 'paid' && planClassOf(acc.latestPlan, acc.pid, this.overrides) === 'free';
    if (acc.downgrade) {
      ev.push({ code: 'DOWNGRADE', label: acc.latestPlan });
    }
    acc.inactive = R.inactiveAttempts[a] > 0;
    acc.inactiveRisk = acc.inactive && !endIsDeactivation;
    if (acc.inactive) {
      ev.push({ code: 'INACTIVE_ATTEMPTS', value: R.inactiveAttempts[a] });
    }
    const premium = R.premiumAttempts[a] - R.premiumPaidContent[a];
    acc.premium = premium > 0;
    if (acc.premium) {
      const title = this.store.strings.values[c.paywallTitle[a]];
      ev.push(
        title
          ? { code: 'PREMIUM_ATTEMPTS', value: premium, label: title }
          : { code: 'PREMIUM_ATTEMPTS', value: premium }
      );
    }

    // Technical: failed playbacks, buffering, or app crashes / error screens.
    const playbacks = R.playbacks[a];
    const failed = R.failedPlaybacks[a];
    if (playbacks >= 1) {
      const share = failed / playbacks;
      const baseShare = B.playbacks[a] > 0 ? B.failedPlaybacks[a] / B.playbacks[a] : 0;
      if (
        share >= Math.max(r.techErrShare, 2 * baseShare) &&
        failed >= r.techMinErrors &&
        R.failedDays[a] >= r.techMinDays
      ) {
        acc.techErrors = true;
        const code = this.store.strings.values[c.topErr[a]];
        ev.push(
          code
            ? { code: 'TECH_ERRORS', value: round(share), ref: round(baseShare), label: code }
            : { code: 'TECH_ERRORS', value: round(share), ref: round(baseShare) }
        );
      }
    }
    const hoursR = R.watchAllMin[a] / 60;
    if (hoursR >= 1) {
      const rate = R.bufferingStops[a] / hoursR;
      const hoursB = B.watchAllMin[a] / 60;
      const baseRate = hoursB > 0 ? B.bufferingStops[a] / hoursB : 0;
      if (rate >= Math.max(r.techBufferingPerHour, 2 * baseRate)) {
        acc.techBuffering = true;
        ev.push({ code: 'TECH_BUFFERING', value: round(rate, 2), ref: round(baseRate, 2) });
      }
    }
    let techGa4 = false;
    if (ga4) {
      if (ga4.crashDays >= GA4_CRASH_DAYS_MIN) {
        techGa4 = true;
        ev.push({ code: 'GA4_CRASHES', value: ga4.crashes, ref: ga4.crashDays });
      }
      if (ga4.errorScreenSessions >= GA4_ERROR_SCREENS_MIN) {
        techGa4 = true;
        ev.push({ code: 'GA4_ERROR_SCREENS', value: ga4.errorScreenSessions, ref: ga4.days });
      }
      if (ga4.accountVisits >= GA4_ACCOUNT_VISITS_MIN) {
        ev.push({ code: 'GA4_ACCOUNT_VISITS', value: ga4.accountVisits, ref: ga4.days });
      }
      if (ga4.logoutClicks >= GA4_LOGOUT_MIN) {
        ev.push({ code: 'GA4_LOGOUT', value: ga4.logoutClicks, ref: ga4.days });
      }
    }
    acc.tech = acc.techErrors || acc.techBuffering || techGa4;

    // A voided, refunded or switched-off subscription is support's case only:
    // a customer who cannot play is no marketing target, whatever else shows.
    acc.atRisk =
      !acc.deactivated &&
      (acc.quiet ||
        acc.fading ||
        acc.lapsed ||
        acc.downgrade ||
        acc.inactiveRisk ||
        (acc.premium && fq) ||
        (acc.expiring && (acc.style === 'repurchase' || fq)));
    // Judged by "returned" in the backtest. Silence itself makes the watch
    // time fall, so fading does not move a quiet customer to another group.
    acc.quietOnly = acc.quiet && !acc.lapsed && !acc.downgrade && !acc.inactiveRisk && !acc.premium && !acc.expiring;
    const activeSubscription = acc.noEnd || expiry === null || expiry >= dEnd;
    acc.lead = !acc.deactivated && acc.premium && activeSubscription && !fq;
    acc.listed = acc.atRisk || acc.lead || acc.tech || acc.deactivated || acc.expiring || acc.lapsedSilent;
    acc.evidence = ev;
  }

  /** Seeds and watch hours of the listed accounts over the recent and baseline windows. */
  private listedDetails(c: Core, need: Uint8Array): ListedDetails {
    const seeds: ListedDetails['seeds'] = new Map();
    const hours = new Map<number, Float64Array>();
    for (const day of this.sortedDays()) {
      const f = day.full;
      if (!f || day.day < c.bStart || day.day > c.asOf) {
        continue;
      }
      const inR = day.day >= c.rStart;
      for (let i = 0; i < day.n; i++) {
        const a = c.local[day.ids[i]];
        if (a < 0 || !need[a]) {
          continue;
        }
        if (f.seedAt[i + 1] > f.seedAt[i]) {
          let cells = seeds.get(a);
          if (!cells) {
            cells = new Map();
            seeds.set(a, cells);
          }
          for (let j = f.seedAt[i]; j < f.seedAt[i + 1]; j++) {
            const key = f.seedProfile[j] * 0x4000000 + f.seedContent[j];
            let cell = cells.get(key);
            if (!cell) {
              cell = { profile: f.seedProfile[j], content: f.seedContent[j], b: 0, r: 0 };
              cells.set(key, cell);
            }
            if (inR) {
              cell.r += f.seedSec[j];
            } else {
              cell.b += f.seedSec[j];
            }
          }
        }
        if (f.hourA[i] >= 0 || f.hourB[i] >= 0) {
          let h = hours.get(a);
          if (!h) {
            h = new Float64Array(24);
            hours.set(a, h);
          }
          if (f.hourA[i] >= 0) {
            h[f.hourA[i]] += f.secA[i];
          }
          if (f.hourB[i] >= 0) {
            h[f.hourB[i]] += f.secB[i];
          }
        }
      }
    }
    return { seeds, hours };
  }

  private details(c: Core, acc: Acc, extra: ListedDetails) {
    const r = this.rules;
    const R = c.R;
    const B = c.B;
    const a = acc.a;
    const cells = [...(extra.seeds.get(a)?.values() ?? [])];

    cells.sort((x, y) => y.b + y.r - (x.b + x.r));
    acc.seeds = cells.slice(0, ASSESSMENT_SEEDS).map((cell) => ({
      profileId: this.store.strings.values[cell.profile],
      contentType: this.store.contentType[cell.content],
      contentId: this.store.contentCid[cell.content],
      title: this.store.contentTitle[cell.content],
      minutes: round((cell.b + cell.r) / 60, 1),
    }));
    const byProfile = new Map<number, number>();
    for (const cell of cells) {
      if (cell.profile) {
        byProfile.set(cell.profile, (byProfile.get(cell.profile) ?? 0) + cell.b + cell.r);
      }
    }
    acc.profileIds = [...byProfile.entries()].sort((x, y) => y[1] - x[1]).map(([p]) => this.store.strings.values[p]);

    const h = extra.hours.get(a);
    if (h) {
      let best = -1;
      for (let k = 0; k < 24; k++) {
        if (h[k] > 0 && (best < 0 || h[k] > h[best])) {
          best = k;
        }
      }
      acc.peakHour = best >= 0 ? best : null;
    }

    const watch = R.watchAllMin[a] + B.watchAllMin[a];
    const live = R.liveMin[a] + B.liveMin[a];
    if (watch <= 0 || live >= LIVE_SHARE_FOR_CHANNELS * watch) {
      acc.recEndpoint = 'tvchannels';
    } else {
      let shows = 0;
      let movies = 0;
      for (const cell of cells) {
        const type = this.store.contentType[cell.content];
        if (type === 'tvshow') {
          shows += cell.b + cell.r;
        } else if (type === 'vod') {
          movies += cell.b + cell.r;
        }
      }
      acc.recEndpoint = shows > movies ? 'tvshows' : 'movies';
    }

    if (!acc.atRisk || !(acc.fading || acc.quiet)) {
      return;
    }
    // Content evidence: why the customer may have lost interest.
    const ev: Evidence[] = [];
    const avgR = R.fullDays[a] > 0 ? R.distinctSum[a] / R.fullDays[a] : NaN;
    const avgB = B.fullDays[a] > 0 ? B.distinctSum[a] / B.fullDays[a] : NaN;
    if (avgB >= 2 && avgR <= r.diversityDrop * avgB) {
      ev.push({ code: 'DIVERSITY_DROP', value: round(avgR, 2), ref: round(avgB, 2) });
    }
    if (R.failedSearchSessions[a] >= r.failedSearchMin) {
      ev.push({ code: 'FAILED_SEARCH', value: R.failedSearchSessions[a], ref: R.searchSessions[a] });
    }
    const baseSec = B.watchAllMin[a] * 60;
    // "Gone" needs the recent seeds (not judged when a recent day lacks them),
    // and a customer who still watches something: for a silent one every
    // title is gone, which says nothing about the content.
    if (baseSec > 0 && R.watchAllMin[a] > 0 && c.recentFullDays > 0 && c.recentLightDays === 0) {
      const byContent = new Map<number, { b: number; r: number }>();
      for (const cell of cells) {
        const sum = byContent.get(cell.content) ?? { b: 0, r: 0 };
        sum.b += cell.b;
        sum.r += cell.r;
        byContent.set(cell.content, sum);
      }
      let top = -1;
      let topB = 0;
      for (const [content, sum] of byContent) {
        if (sum.b > topB) {
          top = content;
          topB = sum.b;
        }
      }
      const share = topB / baseSec;
      if (top >= 0 && share >= r.topTitleShare && (byContent.get(top)?.r ?? 0) <= 0) {
        const title = this.store.contentTitle[top];
        ev.push(
          title
            ? { code: 'TOP_TITLE_GONE', value: round(Math.min(1, share)), label: title }
            : { code: 'TOP_TITLE_GONE', value: round(Math.min(1, share)) }
        );
      }
    }
    if (R.favRemoved[a] > R.favAdded[a] && R.favRemoved[a] >= 2) {
      ev.push({ code: 'FAVORITES_REMOVED', value: R.favRemoved[a], ref: R.favAdded[a] });
    }
    const ga4 = acc.behavior;
    if (ga4 && ga4.searchNoPlaySessions >= GA4_SEARCH_NO_PLAY_MIN) {
      ev.push({ code: 'GA4_SEARCH_NO_PLAY', value: ga4.searchNoPlaySessions, ref: ga4.days });
    }
    if (ga4 && ga4.browseNoPlaySessions >= GA4_BROWSE_NO_PLAY_MIN) {
      ev.push({ code: 'GA4_BROWSE_NO_PLAY', value: ga4.browseNoPlaySessions, ref: ga4.days });
    }
    acc.contentEvidence = ev.length;
    acc.evidence.push(...ev);
  }

  /**
   * The action for an at-risk account (first match of the rules), or null.
   * `floor` = the earliest moment a job can go out (send times, steps).
   */
  private decide(c: Core, acc: Acc, floor: number): KeepJob | null {
    const r = this.rules;
    const { dEnd } = c;
    const fq = acc.fading || acc.quiet;
    const expiry = acc.expiry;
    const ended = expiry !== null && expiry < dEnd;
    const delivery: Delivery = this.deliveryByPid[acc.pid] ?? 'unset';
    const tz = Number.isNaN(c.tz[acc.a]) ? null : c.tz[acc.a];

    let reason: KeepReason;
    let action: KeepAction;
    let offerKind: OfferKind | undefined;
    let offerStep: 1 | 2 | undefined;
    let offerTool: OfferTool = 'none';
    let steps: JobStep[] = [];
    let dueBy: number | null = null;
    let seeds: Seed[] = [];
    let recFallback = false;
    let severityFactor = 1;
    let anchor = isoWeek(c.asOf);

    if (acc.lapsed || (acc.inactiveRisk && ended && expiry !== null)) {
      reason = 'price';
      action = 'retention_offer';
      offerKind = 'win_back';
      const end = expiry ?? dEnd;
      offerStep = dEnd - end < r.winBackStep2Days * DAY ? 1 : 2;
      offerTool = offerStep === 1 ? 'payment_link' : 'discount_or_bonus';
      dueBy = offerStep === 1 ? end + r.winBackStep2Days * DAY : null;
      // One win-back per end: the same step keeps its id across runs and weeks.
      anchor = String(end);
    } else if (acc.downgrade) {
      reason = 'price';
      action = 'retention_offer';
      offerKind = 'win_back_free';
      offerTool = 'plan_change';
    } else if (acc.inactiveRisk || (acc.premium && fq)) {
      reason = 'price';
      action = 'retention_offer';
      offerKind = 'upgrade';
      offerTool = 'plan_change';
    } else if (acc.expiring && expiry !== null && acc.style !== 'at_term') {
      reason = 'timing';
      action = 'renewal_campaign';
      offerTool = 'payment_link';
      anchor = String(expiry);
      dueBy = expiry;
      seeds = fq ? acc.seeds.slice(0, JOB_SEEDS) : [];
      recFallback = fq && !seeds.length;
      steps = this.renewalSteps(expiry, floor, delivery, acc.peakHour, tz);
    } else if (fq) {
      if (acc.expiring && expiry !== null && acc.style === 'at_term') {
        // Renews automatically, but watches less: win the interest back before the end.
        dueBy = expiry - AT_TERM_CONTENT_LEAD_DAYS * DAY;
      }
      if (acc.contentEvidence > 0) {
        reason = 'content';
        action = 'content_push';
        seeds = acc.seeds.slice(0, JOB_SEEDS);
        recFallback = !seeds.length;
      } else {
        reason = 'disengaged';
        action = 're_engagement';
        severityFactor = DISENGAGED_SEVERITY;
        // No reason in the data: start from what the provider's customers watch most.
        recFallback = true;
      }
    } else {
      return null;
    }
    acc.baseReason = reason;

    // Technical problems first: no promotion to someone whose playback fails.
    if (acc.tech) {
      const promo =
        action === 'content_push' ||
        action === 're_engagement' ||
        offerKind === 'upgrade' ||
        (offerKind === 'win_back' && offerStep === 2);
      if (promo) {
        reason = 'technical';
        action = 'support';
        offerKind = undefined;
        offerStep = undefined;
        offerTool = 'none';
        seeds = [];
        recFallback = false;
      }
    }

    const fadeSeverity = acc.fading && acc.fadeRatio !== null ? clamp(1 - acc.fadeRatio, 0, 1) : 0;
    const severity =
      severityFactor *
      Math.max(
        acc.quiet ? 1 : 0,
        acc.lapsed ? 1 : 0,
        acc.inactiveRisk ? 0.9 : 0,
        acc.downgrade ? 0.9 : 0,
        fadeSeverity,
        acc.premium ? 0.7 : 0,
        acc.expiring && acc.style === 'repurchase' ? 0.6 : 0
      );
    let urgency = 0.3;
    if (expiry !== null) {
      urgency =
        expiry >= dEnd
          ? clamp(1 - (expiry - dEnd) / DAY / URGENCY_DAYS, 0, 1)
          : clamp(1 - (dEnd - expiry) / DAY / ruleDays(r.lapsedDays), 0, 1);
    }
    const value = Math.max(
      Math.min(1, acc.baseWatchPerDay / VALUE_WATCH_MIN),
      c.B.activeDays[acc.a] / ruleDays(r.baselineDays)
    );
    const priority = Math.round(100 * (0.4 * severity + 0.3 * urgency + 0.3 * value));

    let sendAt = steps.length ? steps[0].at : this.sendTime(delivery, acc.peakHour, tz, floor);
    if (sendAt !== null && dueBy !== null && action !== 'renewal_campaign' && sendAt > dueBy && dueBy >= floor) {
      sendAt = dueBy;
    }
    const key = `${acc.pid}|${acc.account}`;
    const job: KeepJob = {
      // Another offer (step 1 → 2, upgrade → win-back) is another job: another id.
      id: hash64Hex(`${key}|${action}|${offerKind ?? ''}|${offerStep ?? ''}|${anchor}`),
      key,
      pid: acc.pid,
      account: acc.account,
      accountKey: this.accountKey(acc.g),
      reason,
      action,
      offerTool,
      delivery,
      priority,
      tier: tierOf(priority),
      priorityParts: { severity: round(severity), urgency: round(urgency), value: round(value) },
      sendAt,
      steps,
      dueBy,
      seeds,
      profileIds: acc.profileIds,
      recEndpoint: acc.recEndpoint,
      recFallback,
      techIssue: acc.tech,
      control: false,
      deferred: false,
      evidence: driversFirst(sortEvidence(acc.evidence), DRIVERS[offerKind ?? action] ?? []),
      expiry,
      plan: acc.latestPlan,
      renewalStyle: acc.style,
      consent: 'unknown',
    };
    if (offerKind) {
      job.offerKind = offerKind;
    }
    if (offerStep) {
      job.offerStep = offerStep;
    }
    return job;
  }

  /**
   * Reminder before the end, a last reminder the day before, a payment link
   * the day after. A step whose moment has passed by `floor` is dropped; one
   * still ahead whose channel hour on its date has passed goes in the
   * channel's next slot.
   */
  private renewalSteps(expiry: number, floor: number, channel: Delivery, peakHour: number | null, tz: number | null) {
    const plan: Array<[number, JobStep['what']]> = [
      [expiry - this.rules.renewalLeadDays * DAY, 'reminder'],
      [expiry - DAY, 'reminder'],
      [expiry + DAY, 'payment_link'],
    ];
    const steps: JobStep[] = [];
    for (const [t, what] of plan) {
      let at = this.stepTime(t, channel, peakHour, tz);
      if (at < floor) {
        if (t < floor) {
          continue;
        }
        at = this.sendTime(channel, peakHour, tz, floor) ?? floor;
      }
      if (!steps.some((s) => s.at === at)) {
        steps.push({ at, channel, what });
      }
    }
    return steps.sort((x, y) => x.at - y.at);
  }

  /** A step moved to the channel's hour on its local date (unknown zone: as planned). */
  private stepTime(t: number, channel: Delivery, peakHour: number | null, tz: number | null): number {
    if (tz === null) {
      return t;
    }
    if (channel === 'push' && peakHour !== null) {
      return onLocalDate(t, mod(peakHour - 1, 24), tz);
    }
    if (channel === 'crm') {
      return onLocalDate(t, CRM_LOCAL_HOUR, tz);
    }
    return t;
  }

  /**
   * Push: an hour before the usual viewing hour; CRM: 10:00 local — each the
   * first such moment at or after `floor` (the as-of day has been read by
   * then); else any time.
   */
  private sendTime(delivery: Delivery, peakHour: number | null, tz: number | null, floor: number): number | null {
    if (tz === null) {
      return null;
    }
    if (delivery === 'push') {
      return peakHour === null ? null : slotAtOrAfter(floor, mod(peakHour - 1, 24), tz);
    }
    if (delivery === 'crm') {
      return slotAtOrAfter(floor, CRM_LOCAL_HOUR, tz);
    }
    return null;
  }

  /** Control group by a stable hash; the teams' daily capacity per action, by priority. */
  private applyHoldoutAndCapacity(jobs: KeepJob[]) {
    const r = this.rules;
    for (const job of jobs) {
      // Support is help, not marketing: never withheld for measurement.
      job.control =
        job.action !== 'support' && fnv1a32(`${job.pid}|${job.account}|${r.holdoutSalt}`) / 2 ** 32 < r.holdoutShare;
    }
    const cap = Math.floor(r.dailyCapacity);
    if (!(cap > 0)) {
      return;
    }
    const byAction = new Map<KeepAction, KeepJob[]>();
    for (const job of jobs) {
      if (!job.control) {
        const list = byAction.get(job.action);
        if (list) {
          list.push(job);
        } else {
          byAction.set(job.action, [job]);
        }
      }
    }
    for (const list of byAction.values()) {
      list.sort((x, y) => y.priority - x.priority || compareText(x.id, y.id));
      list.forEach((job, i) => {
        job.deferred = i >= cap;
      });
    }
  }

  /**
   * Both arms from the same reachable population: treated = jobs that will
   * really go out (not deferred by the capacity, a channel that is not
   * 'none'); control = the held-back jobs of such providers.
   */
  private mde(jobs: KeepJob[]): number | null {
    let treat = 0;
    let control = 0;
    for (const job of jobs) {
      if (job.action === 'support' || job.delivery === 'none') {
        continue;
      }
      if (job.control) {
        control++;
      } else if (!job.deferred) {
        treat++;
      }
    }
    if (!treat || !control) {
      return null;
    }
    const rates = (this.lastBacktest?.rows ?? []).filter((row) => row.baseRate > 0).map((row) => row.baseRate);
    const p = rates.length ? rates.reduce((s, v) => s + v, 0) / rates.length : DEFAULT_BASE_RATE;
    return round(100 * MDE_Z * Math.sqrt(p * (1 - p) * (1 / treat + 1 / control)), 1);
  }

  private toAssessment(c: Core, acc: Acc): AccountAssessment {
    const a = acc.a;
    const L = c.lookback;
    const dailyWatch = new Array<number>(L);
    for (let k = 0; k < L; k++) {
      dailyWatch[k] = round(c.dailyWatch[a * L + k], 1);
    }
    const platforms = this.store.strings.values[c.platforms[a]];
    const assessment: AccountAssessment = {
      key: `${acc.pid}|${acc.account}`,
      pid: acc.pid,
      account: acc.account,
      accountKey: this.accountKey(acc.g),
      eligible: acc.eligible,
      atRisk: acc.atRisk,
      baselinePlan: acc.basePlan,
      latestPlan: acc.latestPlan,
      planClass: acc.planClass,
      org: this.store.strings.values[c.org[a]],
      subscriptionId: this.store.strings.values[c.subscriptionId[a]],
      organisationId: this.store.strings.values[c.organisationId[a]],
      expiry: acc.expiry,
      noEnd: acc.noEnd,
      renewalStyle: acc.style,
      deactivatedAt: acc.deactivatedAt,
      deactivated: acc.deactivated,
      lastSeen: acc.lastSeen,
      daysSinceLastSeen: acc.daysSince,
      recent: windowStats(c.R, a),
      baseline: windowStats(c.B, a),
      fadeRatio: acc.fadeRatio,
      dailyWatch,
      platforms: platforms ? platforms.split(',') : [],
      signalCoverage: acc.coverage,
      evidence: acc.job ? acc.job.evidence : sortEvidence(acc.evidence),
      techIssue: acc.tech,
      topErrCode: this.store.strings.values[c.topErr[a]],
      seeds: acc.seeds,
      peakHour: acc.peakHour,
      tzOffsetH: Number.isNaN(c.tz[a]) ? null : c.tz[a],
    };
    if (acc.ineligibleReason) {
      assessment.ineligibleReason = acc.ineligibleReason;
    }
    if (acc.behavior) {
      assessment.behavior = acc.behavior;
    }
    return assessment;
  }

  private quality(c: Core, accs: Acc[]): KeepQuality {
    const plans = new Map<
      string,
      { pid: string; plan: string; planClass: PlanClass; overridden: boolean; accounts: number }
    >();
    const renewalStyles: Record<RenewalStyle, number> = { at_term: 0, early: 0, repurchase: 0, unknown: 0 };
    let eligible = 0;
    let legacyOnly = 0;
    let planUnknown = 0;
    let expiryUnknown = 0;
    let noEnd = 0;
    let matched = 0;
    for (const acc of accs) {
      eligible += acc.eligible ? 1 : 0;
      legacyOnly += acc.coverage === 'legacy_only' ? 1 : 0;
      planUnknown += acc.planClass === 'unknown' ? 1 : 0;
      noEnd += acc.noEnd ? 1 : 0;
      expiryUnknown += acc.expiry === null && !acc.noEnd ? 1 : 0;
      matched += acc.behavior ? 1 : 0;
      renewalStyles[acc.style]++;
      const key = `${acc.pid}|${acc.basePlan}`;
      const entry = plans.get(key);
      if (entry) {
        entry.accounts++;
      } else {
        plans.set(key, {
          pid: acc.pid,
          plan: acc.basePlan,
          planClass: acc.planClass,
          overridden: key in this.overrides,
          accounts: 1,
        });
      }
    }
    const quality: KeepQuality = {
      accounts: accs.length,
      eligible,
      legacyOnly,
      planUnknown,
      expiryUnknown,
      noEnd,
      plans: [...plans.values()].sort(
        (x, y) => y.accounts - x.accounts || (x.pid < y.pid ? -1 : x.pid > y.pid ? 1 : 0)
      ),
      renewalStyles,
      paywall: [...c.paywall.entries()]
        .map(([id, count]) => {
          const name = this.store.strings.values[id];
          const cut = name.indexOf('|');
          const code = cut >= 0 ? name.slice(cut + 1) : name;
          return { platform: cut >= 0 ? name.slice(0, cut) : '', code, count, kind: paywallKind(code) };
        })
        .sort((x, y) => y.count - x.count || compareText(x.platform, y.platform) || compareText(x.code, y.code)),
      days: this.days(),
      missingDays: c.missingDays,
    };
    const status = this.behaviorStatus;
    if (status) {
      const behavior: BehaviorStatus = { status: status.status, matched };
      if (status.window) {
        behavior.window = status.window;
      }
      if (status.requested !== undefined) {
        behavior.requested = status.requested;
      }
      if (status.notLinked !== undefined) {
        behavior.notLinked = status.notLinked;
      }
      if (status.message) {
        behavior.message = status.message;
      }
      quality.behavior = behavior;
    }
    return quality;
  }

  // -------------------------------------------------------------------------
  // Backtest

  backtest(asOfs: number[], opts: EvaluateOptions = {}): BacktestReport {
    const session = this.beginBacktest(asOfs, opts);
    while (session.step()) {
      // Every as-of date in one go.
    }
    return session.report();
  }

  /**
   * The backtest one as-of date per step(); the cooldown and the tallies
   * carry over between steps. Each date is evaluated as its own scan would
   * have been: jobs from the day end plus the settle time (never before
   * opts.notBefore).
   */
  beginBacktest(asOfs: number[], opts: EvaluateOptions = {}): BacktestSession {
    const r = this.rules;
    const state: BacktestState = {
      asOfDays: [...new Set(asOfs.filter(Number.isFinite).map(floorDay))].sort((x, y) => x - y),
      horizon: ruleDays(r.outcomeDays),
      grace: graceDays(r.labelGraceDays),
      notBefore: opts.notBefore,
      tally: new Map(OUTCOME_GROUPS.map((g) => [g, newTally()])),
      lastJob: new Map(),
      suppressed: 0,
      done: 0,
    };
    return {
      get total() {
        return state.asOfDays.length;
      },
      get done() {
        return state.done;
      },
      step: () => {
        if (state.done >= state.asOfDays.length) {
          return false;
        }
        this.backtestDate(state, state.asOfDays[state.done]);
        state.done++;
        return true;
      },
      report: () => this.backtestReport(state),
    };
  }

  /** Evaluates one as-of date and labels what happened next. */
  private backtestDate(state: BacktestState, D: number) {
    const r = this.rules;
    const core = this.core(D);
    const floor = Math.max(core.dEnd + KEEP_DAY_SETTLE_SEC, state.notBefore ?? -Infinity);
    const accs = this.assess(core, false);
    const out = this.outcomes(core, accs, state.horizon, state.grace);
    // Labels per group: 1 = bad outcome, 0 = good, -1 = unknown (censored).
    const label = (group: OutcomeGroup, a: number): number => {
      if (group === 'price' || group === 'timing') {
        return out.subscription[a] === 2 ? 1 : out.subscription[a] === 1 ? 0 : -1;
      }
      if (group === 'quiet') {
        return out.returned[a] < 0 ? -1 : 1 - out.returned[a];
      }
      return out.recovered[a] < 0 ? -1 : 1 - out.recovered[a];
    };
    for (const acc of accs) {
      if (!acc.eligible) {
        continue;
      }
      const job = acc.atRisk ? this.decide(core, acc, floor) : null;
      let flaggedIn: OutcomeGroup | null = null;
      if (job && acc.baseReason) {
        const key = `${acc.pid}|${acc.account}`;
        const prev = state.lastJob.get(key);
        if (prev !== undefined && D - prev < r.cooldownDays * DAY) {
          // Left out of every figure, recall's base included: its outcome
          // belongs to the earlier job.
          state.suppressed++;
          continue;
        }
        state.lastJob.set(key, D);
        flaggedIn = acc.quietOnly ? 'quiet' : groupOfReason(acc.baseReason);
      }
      for (const [group, t] of state.tally) {
        const l = label(group, acc.a);
        if (group === flaggedIn) {
          t.flagged++;
          if (l < 0) {
            t.censored++;
          } else {
            t.labeled++;
            t.positives += l;
          }
        } else if (!acc.atRisk && l >= 0) {
          t.baseLabeled++;
          t.basePositives += l;
        }
        // Recall's base: every bad outcome of this kind, whether the account
        // was flagged here, in another group or not at all.
        if (l > 0) {
          t.allPositives++;
        }
      }
    }
  }

  private backtestReport(state: BacktestState): BacktestReport {
    const rows: BacktestRow[] = OUTCOME_GROUPS.map((group) => {
      const t = state.tally.get(group) ?? newTally();
      const positiveRate = t.labeled ? t.positives / t.labeled : 0;
      const baseRate = t.baseLabeled ? t.basePositives / t.baseLabeled : 0;
      return {
        group,
        flagged: t.flagged,
        labeled: t.labeled,
        censored: t.censored,
        positiveRate: round(positiveRate, 4),
        baseRate: round(baseRate, 4),
        lift: baseRate > 0 && t.labeled ? round(positiveRate / baseRate, 3) : null,
        recall: t.allPositives > 0 ? round(t.positives / t.allPositives, 4) : null,
      };
    });
    const report: BacktestReport = {
      asOfs: state.asOfDays.slice(0, state.done),
      horizonDays: state.horizon,
      rows,
      suppressedByCooldown: state.suppressed,
    };
    this.lastBacktest = report;
    return report;
  }

  /**
   * What happened after the as-of day: the subscription label (renewed /
   * not renewed / censored) and engagement (returned, recovered), per account.
   */
  private outcomes(c: Core, accs: Acc[], horizon: number, grace: number) {
    const r = this.rules;
    const n = c.seen.length;
    const hEnd = c.dEnd + horizon * DAY;
    const gEnd = hEnd + grace * DAY;
    let complete = true;
    for (let d = c.dEnd; d < hEnd; d += DAY) {
      if (!this.hasDay(d, 'light')) {
        complete = false;
      }
    }
    // The end to judge: known at D, from lapsedDays ago up to the horizon.
    const ref = new Float64Array(n).fill(NaN);
    for (const acc of accs) {
      const e = acc.expiry;
      if (acc.eligible && e !== null && e > c.dEnd - r.lapsedDays * DAY && e <= hEnd) {
        ref[acc.a] = e;
      }
    }
    const active = new Float64Array(n);
    const watch = new Float64Array(n);
    const renewed = new Uint8Array(n);
    const notRenewed = new Uint8Array(n);
    for (const day of this.sortedDays()) {
      if (day.day < c.dEnd || day.day >= gEnd) {
        continue;
      }
      const inHorizon = day.day < hEnd;
      for (let i = 0; i < day.n; i++) {
        // Accounts first seen after the as-of day are not judged.
        const id = day.ids[i];
        const a = id < c.local.length ? c.local[id] : -1;
        if (a < 0) {
          continue;
        }
        if (inHorizon) {
          active[a]++;
          watch[a] += day.watchAll[i];
        }
        const end = ref[a];
        if (Number.isNaN(end)) {
          continue;
        }
        for (let j = day.obsAt[i]; j < day.obsAt[i + 1]; j++) {
          const exp = day.obsExp[j];
          const seenAt = day.obsSeen[j];
          if (seenAt <= c.dEnd || seenAt > gEnd) {
            continue;
          }
          if (exp > end + DAY) {
            renewed[a] = 1;
          } else if (exp <= end && seenAt > end + DAY) {
            notRenewed[a] = 1;
          }
          if (exp < c.chainMax[a] && Math.abs(exp - seenAt) <= DEACTIVATION_SLACK_SEC) {
            notRenewed[a] = 1;
          }
        }
      }
    }

    // 2 = not renewed, 1 = renewed, 0 = censored, -1 = no end to judge.
    const subscription = new Int8Array(n).fill(-1);
    const returned = new Int8Array(n).fill(-1);
    const recovered = new Int8Array(n).fill(-1);
    const baselineDays = ruleDays(r.baselineDays);
    for (const acc of accs) {
      const a = acc.a;
      if (!Number.isNaN(ref[a])) {
        subscription[a] = renewed[a] ? 1 : notRenewed[a] ? 2 : 0;
      }
      if (complete) {
        returned[a] = active[a] >= 2 ? 1 : 0;
        // Without watch time (set-top boxes) recovery is judged by active days, as fading is.
        const ok =
          acc.baseWatchPerDay > 0
            ? watch[a] / horizon >= r.recoveryShare * acc.baseWatchPerDay
            : active[a] / horizon >= r.recoveryShare * (c.B.activeDays[a] / baselineDays);
        recovered[a] = ok ? 1 : 0;
      }
    }
    return { subscription, returned, recovered };
  }
}

const compareText = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/** The earliest moment a job of an evaluation can go out: never inside the as-of day. */
function sendFloor(dEnd: number, notBefore: number | undefined): number {
  return notBefore !== undefined && Number.isFinite(notBefore) ? Math.max(dEnd, notBefore) : dEnd;
}

const failedShare = (a: AccountAssessment) =>
  a.recent.playbacks > 0 ? a.recent.failedPlaybacks / a.recent.playbacks : 0;
/** As the buffering rule: only over at least an hour watched. */
const bufferingPerHour = (a: AccountAssessment) =>
  a.recent.watchAllMin >= 60 ? a.recent.bufferingStops / (a.recent.watchAllMin / 60) : 0;

/** Support: deactivated subscriptions first, then the worst playback failures, then buffering. */
function supportOrder(x: AccountAssessment, y: AccountAssessment): number {
  return (
    Number(y.deactivated) - Number(x.deactivated) ||
    failedShare(y) - failedShare(x) ||
    bufferingPerHour(y) - bufferingPerHour(x) ||
    compareText(x.key, y.key)
  );
}

/** Upsell lead strength: refused playbacks of other packages (pay-per-view excluded). */
const leadStrength = (a: AccountAssessment) => a.recent.premiumAttempts - a.recent.premiumPaidContent;

function groupOfReason(reason: KeepReason): OutcomeGroup {
  switch (reason) {
    case 'price':
      return 'price';
    case 'timing':
      return 'timing';
    case 'content':
      return 'content';
    default:
      return 'disengaged';
  }
}

/** True when the parts cover the whole UTC day. */
function covers(parts: Array<[number, number]>, day: number): boolean {
  let cursor = day;
  for (const [from, to] of [...parts].sort((x, y) => x[0] - y[0])) {
    if (from > cursor) {
      break;
    }
    cursor = Math.max(cursor, to);
  }
  return cursor >= day + DAY;
}

/** Seeds of one row: summed per (profile, content), the top ones by seconds. */
function appendSeeds(triples: number[], profiles: number[], contents: number[], secs: number[]) {
  const cells: Array<[number, number, number]> = [];
  for (let k = 0; k < triples.length; k += 3) {
    const held = cells.find((cell) => cell[0] === triples[k] && cell[1] === triples[k + 1]);
    if (held) {
      held[2] += triples[k + 2];
    } else {
      cells.push([triples[k], triples[k + 1], triples[k + 2]]);
    }
  }
  cells.sort((x, y) => y[2] - x[2]);
  for (const [profile, content, sec] of cells.slice(0, DAY_SEEDS)) {
    profiles.push(profile);
    contents.push(content);
    secs.push(sec);
  }
}

/** The two local hours with the most watched seconds: [hourA, secA, hourB, secB] (-1 = none). */
function topHours(pairs: number[]): [number, number, number, number] {
  if (!pairs.length) {
    return [-1, 0, -1, 0];
  }
  const sums = new Map<number, number>();
  for (let k = 0; k < pairs.length; k += 2) {
    sums.set(pairs[k], (sums.get(pairs[k]) ?? 0) + pairs[k + 1]);
  }
  const top = [...sums.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]);
  return [top[0][0], top[0][1], top[1]?.[0] ?? -1, top[1]?.[1] ?? 0];
}
