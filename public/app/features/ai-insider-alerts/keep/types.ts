// Analytix: AI Insider Alerts — "Keep the customer". Shared types of the
// retention scan: per-account daily rows from the Analytix event stream, the
// rules that turn them into risk, a business reason and a ready action, and
// the backtest that checks the rules against what happened next. Like the
// "Tell the customer" section, nothing is sent: the page decides who WOULD get
// which action and when, and exports the hand-off.

/** Tunable rules. Defaults are a starting point until a Backtest calibrates them. */
export interface KeepRules {
  /** Days of the recent window, ending with the as-of day. */
  recentDays: number;
  /** Days of the baseline window right before the recent one. */
  baselineDays: number;
  /**
   * Days read for the subscription history (renewals), ending with the as-of
   * day. Days older than the recent + baseline windows are read with a light
   * query (no content, no errors).
   */
  renewalHistoryDays: number;

  /** A customer to keep was active on at least this many baseline days. */
  minBaselineActiveDays: number;
  /** Also keep customers whose plan is free or a trial. */
  includeFreePlans: boolean;

  /** No activity for at least this many days... */
  quietDays: number;
  /** ...and at least this factor times the longest gap between active baseline days. */
  quietGapFactor: number;

  /** Recent watch time per day at most this share of the baseline (after the provider-wide trend). */
  fadeShare: number;
  /** Fading is judged only for customers who watched at least this many minutes per baseline day. */
  minBaselineWatchMin: number;
  /**
   * A move of the viewing to set-top boxes (which report no watch time) shows
   * as fewer minutes: when the share of plays from such devices grew by more
   * than this, fading also needs fewer plays.
   */
  stbShiftShare: number;

  /** A known subscription end within this many days after the as-of day. */
  renewalWindowDays: number;
  /** A subscription that ended at most this many days ago, while the customer is still around. */
  lapsedDays: number;
  /** Days after the end before "lapsed" (automatic payment retries); a blocked playback skips the wait. */
  lapsedGraceDays: number;
  /** Win-back: step 1 (payment link) until this many days after the end, then step 2 (discount or bonus). */
  winBackStep2Days: number;
  /** Renewal campaign: first step this many days before the end. */
  renewalLeadDays: number;

  /** Technical: share of failed playbacks in the recent window (and at least twice the baseline share)... */
  techErrShare: number;
  /** ...with at least this many failed playbacks... */
  techMinErrors: number;
  /** ...on at least this many different days. */
  techMinDays: number;
  /** Technical: buffering stops per watched hour (and at least twice the baseline). */
  techBufferingPerHour: number;

  /** Content evidence: distinct titles per active day fell to this share of the baseline. */
  diversityDrop: number;
  /** Content evidence: at least this many searches without opening a result. */
  failedSearchMin: number;
  /** Content evidence: the baseline favourite took at least this share of the watch time and is gone. */
  topTitleShare: number;

  /** Share of at-risk customers kept as a control group (never contacted, to measure the effect). */
  holdoutShare: number;
  /** Salt of the control-group hash; change it to draw a new control group (e.g. per quarter). */
  holdoutSalt: string;
  /** Jobs per action and day the teams can handle; the rest is deferred (0 = no limit). */
  dailyCapacity: number;

  /** Backtest: outcome horizon in days after the as-of day. */
  outcomeDays: number;
  /** Backtest: extra days to observe a renewal that the app reports late. */
  labelGraceDays: number;
  /** Backtest: days between as-of dates. */
  backtestStepDays: number;
  /** Backtest: a customer recovered when the horizon's watch time per day reached this share of the baseline. */
  recoveryShare: number;
  /** Backtest: no new job for the same customer within this many days. */
  cooldownDays: number;
}

export const DEFAULT_KEEP_RULES: KeepRules = {
  recentDays: 7,
  baselineDays: 21,
  renewalHistoryDays: 40,
  minBaselineActiveDays: 5,
  includeFreePlans: false,
  quietDays: 5,
  quietGapFactor: 1.5,
  fadeShare: 0.4,
  minBaselineWatchMin: 15,
  stbShiftShare: 0.15,
  renewalWindowDays: 10,
  lapsedDays: 14,
  lapsedGraceDays: 3,
  winBackStep2Days: 7,
  renewalLeadDays: 3,
  techErrShare: 0.2,
  techMinErrors: 5,
  techMinDays: 2,
  techBufferingPerHour: 6,
  diversityDrop: 0.5,
  failedSearchMin: 2,
  topTitleShare: 0.6,
  holdoutShare: 0.2,
  holdoutSalt: '2026Q4',
  dailyCapacity: 0,
  outcomeDays: 21,
  labelGraceDays: 7,
  backtestStepDays: 7,
  recoveryShare: 0.6,
  cooldownDays: 14,
};

/** Bump when the account-day SQL changes: cached days of another version are not reused. */
export const KEEP_SQL_VERSION = 2;
/** A scan whose estimated account-days exceed this is refused before it starts. */
export const KEEP_MAX_ACCOUNT_DAYS = 6_000_000;
/** Full (heavy) days one run may read. */
export const KEEP_MAX_SCAN_DAYS = 80;
/** Days read at the same time. */
export const KEEP_PARALLEL_DAYS = 2;
/** A day counts as complete (and is cached) this long after its end. */
export const KEEP_DAY_SETTLE_SEC = 3 * 3600;

/** `full` = everything; `light` = activity and subscription only (history and outcome days). */
export type DayLevel = 'full' | 'light';

/**
 * One (provider, account) row of one UTC day, as the account-day query returns
 * it (column names = SQL aliases). Fields after the light ones are present on
 * `full` rows only. JSON columns are strings produced by toJSONString.
 */
export interface AccountDayRow {
  pid: string;
  account: string;
  events: number;
  /** Events from builds without the analytics version (set-top boxes, Roku, old Smart TVs). */
  legacy_events: number;
  gated_plays: number;
  ungated_plays: number;
  /** Watched minutes for trends: every stop, capped per stop. */
  watch_all_min: number;
  /** JSON `[[expiry...], [firstSeenTs...]]` (or an object with two arrays): each subscription end seen that day. */
  expiry_seen: string;
  /** Events sent while the subscription end was already in the past. */
  expired_events: number;
  /** Playbacks refused because the subscription is not active. */
  inactive_attempts: number;
  /**
   * JSON `[[expiry...], [firstReportTs...]]` (or an object with two arrays):
   * per subscription end, the first event of the day that still reported it
   * after it had passed — "used the app while that subscription had ended".
   * Unlike expired_events it names the end, so a second device holding an old
   * value does not make another renewal look like a repurchase.
   */
  expired_reports: string;
  plan: string;
  first_ts: number;
  last_ts: number;
  /** Comma-separated device types. */
  platforms: string;

  app_starts?: number;
  sessions?: number;
  play_sessions?: number;
  opens?: number;
  /** Watched minutes by the dashboards' definition (display only). */
  watch_min?: number;
  live_min?: number;
  ondemand_min?: number;
  catchup_min?: number;
  distinct_content?: number;
  /** JSON array of `[[profileId, contentType, contentId, title], seconds, error]` (top 8 by watched seconds). */
  seeds?: string;
  playbacks?: number;
  failed_playbacks?: number;
  buffering_stops?: number;
  top_err_code?: string;
  /** Playbacks refused because the content needs another package. */
  premium_attempts?: number;
  /** ...of which pay-per-view content (never a churn signal). */
  premium_paid_content?: number;
  paywall_title?: string;
  /**
   * JSON `[["<device_type>|<code>"...], [count...]]`: refused playbacks per
   * platform and code (ep10/ep11 as CODE), including candidate forms that are
   * not in the paywall definition yet ('103', 'AE403'), so the Quality tab can
   * show which codes each platform really sends.
   */
  paywall_codes?: string;
  search_sessions?: number;
  failed_search_sessions?: number;
  fav_added?: number;
  fav_removed?: number;
  org?: string;
  /**
   * subscription_id / organisation_id of the latest event. Aliased apart from
   * the column names on purpose: ClickHouse substitutes an alias that equals a
   * column into its own aggregate (ILLEGAL_AGGREGATION).
   */
  sub_id?: string;
  org_id?: string;
  /** JSON array of up to two `[localHour, seconds]` pairs (when the customer watches, local time). */
  hours?: string;
  /** UTC offset of the customer's device in hours; -99 when unknown. */
  tz_offset_h?: number;
}

/**
 * One day of rows in columnar form (the datasource frame's own arrays), so
 * hundreds of thousands of account-days do not become objects. `column(name)`
 * returns the values of an AccountDayRow field (undefined when absent).
 */
export interface DayBlock {
  /** Start of the UTC day (epoch seconds). */
  day: number;
  level: DayLevel;
  /** Part of the day this block covers (two blocks when a day was read in halves). */
  from: number;
  to: number;
  length: number;
  column(name: keyof AccountDayRow): ArrayLike<unknown> | undefined;
}

/**
 * The first frame of a datasource result in its own columnar form (what
 * `runRawFrame` / `queryFrame` return): one array per column, no row objects.
 */
export interface FrameLike {
  length: number;
  fields: Array<{ name: string; values: ArrayLike<unknown> }>;
}

export type PlanClass = 'paid' | 'free' | 'unknown';
/** How the last renewal happened, from the subscription ends the apps reported. */
export type RenewalStyle = 'at_term' | 'early' | 'repurchase' | 'unknown';

export type KeepReason = 'content' | 'price' | 'timing' | 'disengaged' | 'technical';
export type KeepAction =
  | 'content_push'
  | 're_engagement'
  | 'retention_offer'
  | 'renewal_campaign'
  /** Technical problems: hand-off to support / Tell the customer, never marketing. */
  | 'support';
export type OfferKind = 'win_back' | 'win_back_free' | 'upgrade';
export type OfferTool = 'payment_link' | 'discount_or_bonus' | 'plan_change' | 'none';
export type Delivery = 'push' | 'crm' | 'none' | 'unset';
export type PriorityTier = 'high' | 'medium' | 'low';

/** Short machine codes of the evidence behind a decision; the UI turns them into sentences. */
export type EvidenceCode =
  | 'QUIET'
  | 'FADING'
  | 'FADING_PLAYS'
  | 'EXPIRING'
  | 'LAPSED'
  | 'LAPSED_SILENT'
  | 'DOWNGRADE'
  | 'INACTIVE_ATTEMPTS'
  | 'PREMIUM_ATTEMPTS'
  | 'DEACTIVATED'
  | 'RENEWAL_REPURCHASE'
  | 'DIVERSITY_DROP'
  | 'FAILED_SEARCH'
  | 'TOP_TITLE_GONE'
  | 'FAVORITES_REMOVED'
  | 'TECH_ERRORS'
  | 'TECH_BUFFERING'
  | 'GA4_SEARCH_NO_PLAY'
  | 'GA4_BROWSE_NO_PLAY'
  | 'GA4_CRASHES'
  | 'GA4_ERROR_SCREENS'
  | 'GA4_ACCOUNT_VISITS'
  | 'GA4_LOGOUT';

export interface Evidence {
  code: EvidenceCode;
  /** The number behind the code (days, share, count...), for the sentence. */
  value?: number;
  /** A second number (e.g. the baseline it is compared with). */
  ref?: number;
  /** A short label (a title, a plan name, an error code). */
  label?: string;
}

/** Something the recommendation engine can start from: what a profile watched. */
export interface Seed {
  profileId: string;
  contentType: string;
  contentId: string;
  title: string;
  minutes: number;
}

/** Window sums of one account (recent or baseline). */
export interface WindowStats {
  activeDays: number;
  events: number;
  legacyEvents: number;
  gatedPlays: number;
  ungatedPlays: number;
  watchAllMin: number;
  watchMin: number;
  liveMin: number;
  ondemandMin: number;
  catchupMin: number;
  /** Mean distinct titles per active day (uniq counts do not add up across days). */
  distinctPerDay: number;
  playbacks: number;
  failedPlaybacks: number;
  failedDays: number;
  bufferingStops: number;
  inactiveAttempts: number;
  premiumAttempts: number;
  premiumPaidContent: number;
  searchSessions: number;
  failedSearchSessions: number;
  favAdded: number;
  favRemoved: number;
  appStarts: number;
}

/** Everything the rules found about one account on the as-of day. */
export interface AccountAssessment {
  /** `${pid}|${account}` */
  key: string;
  pid: string;
  account: string;
  /** upper case, no '-' — the key shared with GA4. */
  accountKey: string;
  eligible: boolean;
  /** Why not eligible: 'new' (too few baseline days) or 'free'. */
  ineligibleReason?: 'new' | 'free';
  atRisk: boolean;
  baselinePlan: string;
  latestPlan: string;
  planClass: PlanClass;
  org: string;
  subscriptionId: string;
  organisationId: string;
  /** Current subscription end (epoch), null when unknown; noEnd for plans without one. */
  expiry: number | null;
  noEnd: boolean;
  renewalStyle: RenewalStyle;
  deactivatedAt: number | null;
  /**
   * The current subscription end is a void / refund / switch-off made inside
   * the lookback (support only, no offers). A new purchase after it clears it.
   */
  deactivated: boolean;
  lastSeen: number;
  daysSinceLastSeen: number;
  recent: WindowStats;
  baseline: WindowStats;
  /** Normalized fading ratio (1 = as usual), null when not judged. */
  fadeRatio: number | null;
  /** Watched minutes per day over the lookback, oldest first (sparkline). */
  dailyWatch: number[];
  platforms: string[];
  /**
   * 'full' = only apps with analytics; 'mixed' = also set-top boxes / old
   * builds; 'legacy_only' = only those (no watch time, errors or subscription).
   */
  signalCoverage: 'full' | 'mixed' | 'legacy_only';
  evidence: Evidence[];
  techIssue: boolean;
  topErrCode: string;
  seeds: Seed[];
  /** Local hour the customer usually watches (0-23), null when unknown. */
  peakHour: number | null;
  tzOffsetH: number | null;
  behavior?: BehaviorMetrics;
}

/** One step of a multi-step action (renewal campaign). */
export interface JobStep {
  at: number;
  channel: Delivery;
  what: 'reminder' | 'payment_link' | 'content';
}

/** A ready action for marketing (or support): who, what, when, and why. */
export interface KeepJob {
  id: string;
  key: string;
  pid: string;
  account: string;
  accountKey: string;
  reason: KeepReason;
  action: KeepAction;
  offerKind?: OfferKind;
  offerStep?: 1 | 2;
  offerTool: OfferTool;
  delivery: Delivery;
  priority: number;
  tier: PriorityTier;
  priorityParts: { severity: number; urgency: number; value: number };
  /** First send time (epoch), null = any time. */
  sendAt: number | null;
  steps: JobStep[];
  /** Latest useful moment (e.g. before the subscription ends), null when none. */
  dueBy: number | null;
  /** Recommendation engine input: what to start from and for which profile. */
  seeds: Seed[];
  profileIds: string[];
  recEndpoint: 'tvchannels' | 'movies' | 'tvshows';
  /** No seeds: start from the provider's most viewed instead. */
  recFallback: boolean;
  techIssue: boolean;
  control: boolean;
  deferred: boolean;
  evidence: Evidence[];
  expiry: number | null;
  plan: string;
  renewalStyle: RenewalStyle;
  /** Consent to marketing is not known to Analytix; the receiving team checks it. */
  consent: 'unknown';
}

/** Coverage and quality figures of the scanned data. */
export interface KeepQuality {
  accounts: number;
  eligible: number;
  legacyOnly: number;
  planUnknown: number;
  expiryUnknown: number;
  noEnd: number;
  /** Per pid and plan: the class the rules use and how many accounts carry it. */
  plans: Array<{ pid: string; plan: string; planClass: PlanClass; overridden: boolean; accounts: number }>;
  renewalStyles: Record<RenewalStyle, number>;
  /**
   * Refused playbacks per single platform and code (`<slot 10>/<slot 11>`),
   * recent and baseline windows, most first. kind: 'inactive' = subscription
   * not active, 'premium' = another package (both in the paywall definition),
   * 'candidate' = a form not in the definition yet ('103', 'AE403'), shown so
   * the codes each platform really sends can be checked.
   */
  paywall: Array<{ platform: string; code: string; count: number; kind: 'inactive' | 'premium' | 'candidate' }>;
  /** Days read and their level; days missing for the as-of day's windows. */
  days: Array<{ day: number; level: DayLevel; rows: number }>;
  missingDays: number[];
  behavior?: BehaviorStatus;
}

export interface RenewalItem {
  key: string;
  pid: string;
  account: string;
  expiry: number;
  renewalStyle: RenewalStyle;
  atRisk: boolean;
  /** 'check_autopay' = renews without a job; 'expired_silent' = ended and gone quiet. */
  kind: 'at_risk' | 'check_autopay' | 'expired_silent';
  plan: string;
}

export interface KeepSnapshot {
  asOf: number;
  pids: string[] | null;
  assessments: AccountAssessment[];
  jobs: KeepJob[];
  renewals: RenewalItem[];
  /** Premium paywall while the subscription is active, without fading: an upsell lead, not a risk. */
  leads: AccountAssessment[];
  /** Technical problems and deactivated subscriptions. */
  support: AccountAssessment[];
  quality: KeepQuality;
  backtest?: BacktestReport;
  /** Minimum detectable effect (percentage points) with the current treatment / control sizes. */
  mdePct: number | null;
}

export type OutcomeGroup = 'price' | 'timing' | 'content' | 'disengaged' | 'quiet';

export interface BacktestRow {
  group: OutcomeGroup;
  /** Accounts flagged in this group (summed over as-of dates). */
  flagged: number;
  /** ...with a known outcome. */
  labeled: number;
  censored: number;
  /** Share of flagged accounts with the bad outcome. */
  positiveRate: number;
  /** Same share among eligible accounts that were not flagged. */
  baseRate: number;
  lift: number | null;
  /** Share of all bad outcomes (among eligible) that were flagged. */
  recall: number | null;
}

export interface BacktestReport {
  asOfs: number[];
  horizonDays: number;
  rows: BacktestRow[];
  /** Jobs that the cooldown suppressed on later as-of dates. */
  suppressedByCooldown: number;
}

/** GA4 evidence of one account for the recent window (backend `POST /api/keep/behavior`). */
export interface BehaviorMetrics {
  days: number;
  sessions: number;
  engagementMin: number;
  searchSessions: number;
  searchNoPlaySessions: number;
  browseNoPlaySessions: number;
  crashes: number;
  crashDays: number;
  errorScreenSessions: number;
  noInternetSessions: number;
  accountVisits: number;
  logoutClicks: number;
  myListAdds: number;
  myListRemoves: number;
  platforms: string[];
}

export interface BehaviorRow extends BehaviorMetrics {
  pid: string;
  /** Normalized account key (upper case, no '-'). */
  account: string;
}

export type BehaviorStatusCode = 'on' | 'partial' | 'pending' | 'off' | 'budget' | 'error' | 'unavailable';

export interface BehaviorStatus {
  status: BehaviorStatusCode;
  /** Days (YYYY-MM-DD, property time zone) the evidence covers. */
  window?: { from: string; to: string; days: number };
  matched?: number;
  requested?: number;
  /** Accounts of providers without a GA4 property bound to them (not looked up at all). */
  notLinked?: number;
  message?: string;
}

export interface BehaviorResult extends BehaviorStatus {
  rows: BehaviorRow[];
}

/** Engine inputs that are settings rather than rules. */
export interface KeepEngineOptions {
  /** `pid|plan` → class. */
  planClassOverrides?: Record<string, PlanClass>;
  /** pid → how its customers can be reached (see parseDeliveryByPid in engine.ts). */
  deliveryByPid?: Record<string, Delivery>;
}

/** Which days a run needs. All values are starts of UTC days (epoch seconds), ascending. */
export interface ScanPlan {
  full: number[];
  light: number[];
  /** As-of dates evaluated (one for a scan). */
  asOfs: number[];
  /** Days to keep in memory; everything else may be evicted. */
  keepFrom: number;
  keepTo: number;
}

export interface KeepProgress {
  phase: 'estimate' | 'days' | 'evaluate' | 'behavior' | 'done';
  done: number;
  total: number;
  /** Day being read (start of the UTC day). */
  day?: number;
}

/** Size of a scan before it runs (from the daily aggregates). */
export interface ScanEstimate {
  perPid: Array<{ pid: string; accounts: number }>;
  accountsPerDay: number;
  accountDays: number;
  tooLarge: boolean;
}

/** Options of one evaluation. */
export interface EvaluateOptions {
  /**
   * Earliest moment a job can go out (epoch seconds): send times and renewal
   * steps never fall before it. Scans: max(now, as-of day end + settle time);
   * backtests: the as-of day end + settle time. Default: the as-of day end.
   */
  notBefore?: number;
}

/** A backtest in progress (see KeepEngineApi.beginBacktest). */
export interface BacktestSession {
  readonly total: number;
  readonly done: number;
  /** Evaluates and labels the next as-of date; false when all are done. */
  step(): boolean;
  /** The report over the dates done so far. */
  report(): BacktestReport;
}

/** The engine as the runner and the UI use it. */
export interface KeepEngineApi {
  readonly rules: KeepRules;
  /** True when the day is held at least at this level. */
  hasDay(day: number, level: DayLevel): boolean;
  /** Adds a day (or half a day); a second block of the same day adds to the first. */
  ingestDay(block: DayBlock): void;
  /** Forgets days outside [from, to] (memory bound for long backtests). */
  evictOutside(from: number, to: number): void;
  setBehavior(result: BehaviorResult | null): void;
  /** Rules on the as-of day (start of a UTC day). */
  evaluate(asOf: number, opts?: EvaluateOptions): KeepSnapshot;
  /** Rules on each as-of date plus what happened next. */
  backtest(asOfs: number[], opts?: EvaluateOptions): BacktestReport;
  /**
   * The same backtest one as-of date at a time, so the caller can yield to the
   * page, show progress and stop between dates.
   */
  beginBacktest?(asOfs: number[], opts?: EvaluateOptions): BacktestSession;
  /** Held days and their levels. */
  days(): Array<{ day: number; level: DayLevel; rows: number }>;
  /**
   * Optional: an engine with other rules / options over the days this one
   * already holds, so editing a rule does not read ClickHouse again. Without
   * it the page starts a new engine and the days are read again.
   */
  withSettings?(rules: KeepRules, options: KeepEngineOptions): KeepEngineApi;
}

/** Settings of the section that are not rules. */
export interface KeepSettings {
  asOf: string;
  mode: 'scan' | 'backtest';
  backtestFrom: string;
  backtestTo: string;
  /** `111=crm, 222=push` — how each provider can reach its customers. */
  deliveryByPid: string;
  /** Ask the backend for GA4 evidence when the organization has it. */
  useBehavior: boolean;
  /** `pid|plan` → class, when the name-based guess is wrong. */
  planClassOverrides: Record<string, PlanClass>;
  /** Titles in the marketing CSV (ids only otherwise). */
  includeTitles: boolean;
  rules: KeepRules;
}
