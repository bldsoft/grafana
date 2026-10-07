// Analytix: AI Insider Alerts - shared types of the incident replay / live
// detector. Everything up to (but not including) sending messages: the page
// decides who WOULD be told what and when, so the rules can be validated on
// past days before a delivery channel exists.

/** Tunable rules. Defaults come from the 2026-09-29 production replay. */
export interface AlertRules {
  /** A channel-minute is "bad" only with at least this many active viewers. */
  minUsers: number;
  /** ...and at least this many viewers with a playback error in that minute. */
  minErrUsers: number;
  /** ...and the erroring viewers are at least this share of the active ones (0..1). */
  minErrShare: number;
  /** Bad minutes needed before an incident is confirmed (detection). */
  confirmMinutes: number;
  /**
   * Clean minutes (watched, almost no errors) needed before the channel is
   * declared back. Minutes too thin to judge do not count: a channel whose
   * audience merely dropped below the thresholds is not "back".
   */
  recoveryMinutes: number;
  /** A minute counts as clean only with at least this many active viewers. */
  recoveryMinUsers: number;
  /**
   * With no clean minutes at all, a confirmed incident is closed this long
   * after its last failing minute — silently, without a "back" message,
   * because nothing proves the channel works again.
   */
  quietCloseMinutes: number;
  /**
   * Minutes after detection the channel must still be failing before a push is
   * sent. Shorter blips only get an in-player message: on 2026-09-29, 54 of 82
   * incidents were over within a minute of detection, so a push would have
   * arrived after the channel was already back.
   */
  pushDelayMinutes: number;
  /** A viewer told about a channel is not told again about it within this window. */
  cooldownMinutes: number;
  /**
   * A channel that confirms this many incidents within flapWindowMinutes is
   * "unstable": its viewers get one message for the whole series, not one per
   * failure, and one "stable again" once it has held for the window.
   */
  flapCount: number;
  flapWindowMinutes: number;
  /**
   * Provider-wide detection, for outages spread thinly over many channels
   * (a data centre, a middleware): per provider and 15 minutes, viewers with
   * an error against the median of the same time on previous days.
   */
  providerMinErrUsers: number;
  providerSurgeFactor: number;
  /** Consecutive surging 15-minute buckets that confirm a provider incident. */
  providerConfirmBuckets: number;
  /** Previous days the baseline is taken from (1-7). */
  providerBaselineDays: number;
  /**
   * A provider-wide push goes only to viewers who kept failing: at least this
   * many errors spread over two minutes or more. One-off errors during the
   * surge get the in-player message instead.
   */
  providerMinViewerErrors: number;
  /** Viewers who watched the channel this long in the hour before get an apology. */
  apologyWatchMinutes: number;
  /** Customer-side diagnosis: errors on at least this many healthy channels... */
  customerMinChannels: number;
  /** ...spread over at least this many minutes. */
  customerMinMinutes: number;
}

export const DEFAULT_RULES: AlertRules = {
  minUsers: 8,
  minErrUsers: 4,
  minErrShare: 0.25,
  confirmMinutes: 2,
  recoveryMinutes: 5,
  recoveryMinUsers: 3,
  quietCloseMinutes: 60,
  pushDelayMinutes: 3,
  cooldownMinutes: 60,
  flapCount: 3,
  flapWindowMinutes: 120,
  providerMinErrUsers: 30,
  providerSurgeFactor: 2.5,
  providerConfirmBuckets: 2,
  providerBaselineDays: 3,
  providerMinViewerErrors: 3,
  apologyWatchMinutes: 10,
  customerMinChannels: 3,
  customerMinMinutes: 3,
};

/** One failing channel-minute (query A). Times are epoch seconds (UTC). */
export interface BadMinuteRow {
  minute: number;
  pid: string;
  provider: string;
  cid: string;
  title: string;
  users: number;
  errUsers: number;
  errEvents: number;
  /** Viewers whose error is an HTTP 4xx/5xx or "stream not found" code: server side. */
  srvErrUsers: number;
  /** Stream path without scheme, host and playlist file, e.g. `prn2/10008/live/hls/Topchannel`. */
  topPath: string;
  topHost: string;
  topPlatform: string;
  topCode: string;
}

/** One provider and 15-minute bucket (query P). */
export interface ProviderBucketRow {
  bucket: number;
  pid: string;
  users: number;
  errUsers: number;
  srvErrUsers: number;
  errEvents: number;
  topCode: string;
  topPlatform: string;
}

/** A provider-wide error surge against its usual level. */
export interface ProviderIncident {
  id: string;
  pid: string;
  provider: string;
  /** Start of the first surging bucket. */
  start: number;
  /** End of the confirming bucket; undefined until confirmed. */
  detectedAt?: number;
  /** Start of the last surging bucket. */
  lastSurge: number;
  closedAt?: number;
  /** true = back to its usual level, false = went quiet without evidence. */
  recovered?: boolean;
  surgeBuckets: number;
  series: Array<{ bucket: number; users: number; errUsers: number; baselineErr: number }>;
  peakErrUsers: number;
  /** Baseline of the peak bucket. */
  peakBaselineErr: number;
  peakRatio: number;
  codes: Record<string, number>;
  platforms: Record<string, number>;
  /** Shared with other providers surging at the same time (infrastructure). */
  groupId?: string;
}

/** One viewer hit by one incident (query B). */
export interface AffectedUserRow {
  incidentId: string;
  userId: string;
  platform: string;
  network: string;
  isp: string;
  city: string;
  firstErr: number;
  lastErr: number;
  errEvents: number;
  topCode: string;
  /** Seconds of clean viewing of the channel in the hour before the incident. */
  watchedBeforeSec: number;
}

/** A viewer failing on channels that are healthy for everyone else (query C). */
export interface CustomerSideRow {
  pid: string;
  provider: string;
  userId: string;
  platform: string;
  network: string;
  isp: string;
  city: string;
  channels: number;
  minutes: number;
  errEvents: number;
  firstMinute: number;
  lastMinute: number;
  topCode: string;
}

/** Per-channel server-error / clean-viewing counts for one chunk (query D). */
export interface ChannelHealthRow {
  pid: string;
  provider: string;
  cid: string;
  title: string;
  srvErrUsers: number;
  okUsers: number;
  triedUsers: number;
}

/** Whole-window error volume (query E): the "message per error" baselines. */
export interface ErrorVolumeRow {
  errEvents: number;
  errUsers: number;
  userErrMinutes: number;
}

export type IncidentClass = 'push' | 'in_app' | 'chronic' | 'pending' | 'unstable';

export interface Incident {
  id: string;
  pid: string;
  provider: string;
  cid: string;
  title: string;
  /** First bad minute. */
  start: number;
  /** When the incident was confirmed (end of the confirming bad minute); undefined until then. */
  detectedAt?: number;
  /** When a push became due (still failing pushDelay minutes after detection). */
  escalatedAt?: number;
  /** Start of the last bad minute seen so far. */
  lastBad: number;
  /** When the incident was closed; undefined while still open. */
  closedAt?: number;
  /**
   * true = closed on clean viewing (a "back" message is due), false = closed
   * after a quiet period without evidence (no "back" message).
   */
  recovered?: boolean;
  /** Consecutive clean minutes seen while open. */
  cleanStreak: number;
  badMinutes: number;
  peakUsers: number;
  peakErrUsers: number;
  peakErrShare: number;
  errEvents: number;
  srvErrUsersMax: number;
  /** Per-minute series of the bad minutes (for the sparkline). */
  series: Array<{ minute: number; users: number; errUsers: number }>;
  paths: Record<string, number>;
  hosts: Record<string, number>;
  platforms: Record<string, number>;
  codes: Record<string, number>;
  /** Set when the channel was flagged dead (no clean viewing) around the incident. */
  chronic: boolean;
  /** Previous incident on the same channel inside the cooldown window. */
  reopenOf?: string;
  /** Part of an unstable-channel series (see AlertRules.flapCount). */
  unstable: boolean;
  /** The unstable series this incident belongs to. */
  episodeId?: string;
  /** Correlation group shared with incidents of the same source or origin. */
  groupId?: string;
}

export type DecisionKind = 'down' | 'unstable' | 'back' | 'apology' | 'in_app' | 'suppressed' | 'diagnosis';

export interface Decision {
  kind: DecisionKind;
  /** When the message would go out. */
  at: number;
  userId: string;
  pid: string;
  provider: string;
  /** Channel id, empty for customer-side diagnoses. */
  cid: string;
  title: string;
  incidentId?: string;
  reason: string;
  platform: string;
}

export interface CorrelationGroup {
  id: string;
  label: string;
  incidentIds: string[];
}

export interface DeadChannel {
  pid: string;
  provider: string;
  cid: string;
  title: string;
  srvErrUsers: number;
  triedUsers: number;
  firstSeen: number;
  lastSeen: number;
}

/** One channel across the whole run, for the ops report. */
export interface ChannelReportRow {
  pid: string;
  provider: string;
  cid: string;
  title: string;
  incidents: number;
  /** Distinct UTC days with an incident. */
  days: number;
  failingMinutes: number;
  /** Sum of viewers hit per incident (a viewer hit twice counts twice). */
  viewersHit: number;
  pushIncidents: number;
  unstableIncidents: number;
  /** Incidents where nearly everyone failed and nobody watched afterwards. */
  offAir: number;
  dead: boolean;
  topPath: string;
  topPlatform: string;
  topCode: string;
  firstStart: number;
  lastStart: number;
}

export interface AlertSummary {
  incidents: number;
  providerIncidents: number;
  /** Provider incidents that overlap with other providers' (shared infrastructure). */
  infraGroups: number;
  pushIncidents: number;
  unstableIncidents: number;
  inAppIncidents: number;
  chronicIncidents: number;
  openIncidents: number;
  down: number;
  unstable: number;
  back: number;
  apology: number;
  inApp: number;
  suppressedRepeats: number;
  suppressedCooldown: number;
  diagnoses: number;
  deadChannels: number;
  /** Baselines: one message per error event / per viewer per error minute. */
  naiveErrEvents: number;
  naiveUserMinutes: number;
  /** Median minutes between the first error and detection. */
  medianDetectLagMin?: number;
}
