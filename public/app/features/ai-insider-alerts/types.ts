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
  /** Clean minutes after the last bad one before the channel is declared back. */
  recoveryMinutes: number;
  /**
   * Minutes after detection the channel must still be failing before a push is
   * sent. Shorter blips only get an in-player message: on 2026-09-29, 54 of 82
   * incidents were over within a minute of detection, so a push would have
   * arrived after the channel was already back.
   */
  pushDelayMinutes: number;
  /** A viewer told about a channel is not told again about it within this window. */
  cooldownMinutes: number;
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
  pushDelayMinutes: 3,
  cooldownMinutes: 60,
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

/** One viewer hit by one incident (query B). */
export interface AffectedUserRow {
  incidentId: string;
  userId: string;
  platform: string;
  network: string;
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

export type IncidentClass = 'push' | 'in_app' | 'chronic' | 'pending';

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
  /** When recovery was confirmed; undefined while still open. */
  closedAt?: number;
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
  /** Correlation group shared with incidents of the same source or origin. */
  groupId?: string;
}

export type DecisionKind = 'down' | 'back' | 'apology' | 'in_app' | 'suppressed' | 'diagnosis';

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

export interface AlertSummary {
  incidents: number;
  pushIncidents: number;
  inAppIncidents: number;
  chronicIncidents: number;
  openIncidents: number;
  down: number;
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
