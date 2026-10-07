// Analytix: AI Insider Alerts - the decision engine. Pure TypeScript with no
// Grafana dependencies, so the same rules can later move to a server-side
// runner unchanged. It consumes query results chunk by chunk in time order
// (a replay of past days or the live tail) and answers two questions:
//   1. is a channel down on the operator side right now (an incident), and
//   2. which viewer would be told what, and when — or deliberately not told.

import { PROVIDER_BUCKET_SEC, type IncidentWindow, type ProviderWindow } from './sql';
import type {
  AffectedUserRow,
  AlertRules,
  AlertSummary,
  BadMinuteRow,
  ChannelHealthRow,
  ChannelReportRow,
  CorrelationGroup,
  CustomerSideRow,
  DeadChannel,
  Decision,
  ErrorVolumeRow,
  Incident,
  IncidentClass,
  ProviderBucketRow,
  ProviderIncident,
} from './types';

const MIN = 60;
const DAY = 86400;
/** Window over which a channel with only server errors and no clean viewing counts as dead. */
const DEAD_WINDOW_SEC = 3 * 3600;
/** Server-error viewers needed in that window before a channel is called dead. */
const DEAD_MIN_SRV_USERS = 3;
/** Incidents on one origin directory belong together only when they start this close. */
const ORIGIN_ONSET_SEC = 5 * MIN;
/** Provider incidents of several providers belong together when they start this close. */
const INFRA_ONSET_SEC = 30 * MIN;
/** A provider in an incident with no activity at all for this long is closed without evidence. */
const PROVIDER_QUIET_SEC = 4 * 900;
/** One customer-side diagnosis per viewer per day. */
const DIAGNOSIS_COOLDOWN_SEC = DAY;

function channelKey(pid: string, cid: string): string {
  return `${pid}|${cid}`;
}

function bump(map: Record<string, number>, key: string, by = 1) {
  if (key) {
    map[key] = (map[key] ?? 0) + by;
  }
}

/** The most frequent key of a counter, '' when empty. */
export function topKey(map: Record<string, number>): string {
  let best = '';
  let bestCount = -1;
  for (const [key, count] of Object.entries(map)) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

function median(values: number[]): number | undefined {
  if (!values.length) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The parent directory of a stream path (`a/b/c` → `a/b`). */
function parentPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '';
}

interface HealthSample {
  from: number;
  to: number;
  srvErrUsers: number;
  okUsers: number;
  triedUsers: number;
}

export class AlertEngine {
  readonly rules: AlertRules;
  private incidents: Incident[] = [];
  private open = new Map<string, Incident>();
  /** Incidents with new bad minutes since their viewers were last fetched. */
  private dirty = new Set<string>();
  private affected = new Map<string, AffectedUserRow[]>();
  private health = new Map<string, { row: ChannelHealthRow; samples: HealthSample[] }>();
  private dead = new Map<string, DeadChannel>();
  private customer = new Map<string, CustomerSideRow>();
  private volume: ErrorVolumeRow = { errEvents: 0, errUsers: 0, userErrMinutes: 0 };
  private providerNames = new Map<string, string>();
  private blips = 0;
  /** Provider buckets read so far (window and baseline days), by pid|bucket. */
  private provRows = new Map<string, ProviderBucketRow>();
  /** Buckets whose provider rows were read: a missing row there means "no activity". */
  private provCovered = new Set<number>();
  private provIncidents: ProviderIncident[] = [];
  private provOpen = new Map<string, ProviderIncident>();
  private provDirty = new Set<string>();
  private provAffected = new Map<string, AffectedUserRow[]>();
  private seq = 0;
  /** End of the last processed window. */
  clock = 0;
  /** Provider buckets are evaluated up to here (complete buckets only). */
  providerWatermark?: number;

  constructor(rules: AlertRules) {
    this.rules = rules;
  }

  setProviderNames(names: Record<string, string>) {
    for (const [pid, name] of Object.entries(names)) {
      if (name) {
        this.providerNames.set(pid, name);
      }
    }
  }

  providerName(pid: string): string {
    return this.providerNames.get(pid) ?? '';
  }

  /** Feed the failing channel-minutes of one window (only bad rows). */
  ingestBadMinutes(rows: BadMinuteRow[]) {
    this.ingestMinutes(rows);
  }

  /**
   * Feed the watched minutes of the followed channels — failing, clean and
   * thin alike — sorted by minute. Failing minutes open and extend
   * incidents; clean ones count towards recovery; thin ones are neutral.
   */
  ingestMinutes(rows: BadMinuteRow[]) {
    const sorted = [...rows].sort((a, b) => a.minute - b.minute);
    for (const row of sorted) {
      // Incidents are closed as time passes, so the open set always reflects
      // "now" = this minute while walking the window.
      this.advance(row.minute);
      if (this.isBad(row)) {
        this.addBadMinute(row);
      } else {
        this.addOtherMinute(row);
      }
    }
  }

  /** Channels with an open incident: their every minute must be read next. */
  followedChannels(): Array<{ pid: string; cid: string }> {
    return [...this.open.values()].map((i) => ({ pid: i.pid, cid: i.cid }));
  }

  private isBad(row: BadMinuteRow): boolean {
    const r = this.rules;
    return row.users >= r.minUsers && row.errUsers >= r.minErrUsers && row.errUsers >= r.minErrShare * row.users;
  }

  private addOtherMinute(row: BadMinuteRow) {
    const inc = this.open.get(channelKey(row.pid, row.cid));
    if (!inc || inc.detectedAt === undefined) {
      return;
    }
    const share = row.users ? row.errUsers / row.users : 0;
    if (row.users >= Math.max(1, this.rules.recoveryMinUsers) && share < this.rules.minErrShare / 2) {
      inc.cleanStreak += 1;
      if (inc.cleanStreak >= Math.max(1, this.rules.recoveryMinutes)) {
        inc.closedAt = row.minute + MIN;
        inc.recovered = true;
        this.open.delete(channelKey(inc.pid, inc.cid));
      }
    } else if (row.errUsers > 0 && share >= this.rules.minErrShare) {
      // Still failing for the few who watch: below the incident thresholds,
      // but certainly not a sign of recovery.
      inc.cleanStreak = 0;
    }
  }

  private addBadMinute(row: BadMinuteRow) {
    const key = channelKey(row.pid, row.cid);
    let inc = this.open.get(key);
    if (!inc) {
      inc = this.newIncident(row);
      this.open.set(key, inc);
      this.incidents.push(inc);
    }
    const r = this.rules;
    inc.lastBad = Math.max(inc.lastBad, row.minute);
    inc.badMinutes += 1;
    inc.cleanStreak = 0;
    inc.title = inc.title || row.title;
    inc.peakUsers = Math.max(inc.peakUsers, row.users);
    inc.peakErrUsers = Math.max(inc.peakErrUsers, row.errUsers);
    inc.peakErrShare = Math.max(inc.peakErrShare, row.users ? row.errUsers / row.users : 0);
    inc.errEvents += row.errEvents;
    inc.srvErrUsersMax = Math.max(inc.srvErrUsersMax, row.srvErrUsers);
    inc.series.push({ minute: row.minute, users: row.users, errUsers: row.errUsers });
    bump(inc.paths, row.topPath, row.errUsers);
    bump(inc.hosts, row.topHost, row.errUsers);
    bump(inc.platforms, row.topPlatform, row.errUsers);
    bump(inc.codes, row.topCode, row.errUsers);

    if (inc.detectedAt === undefined && inc.badMinutes >= Math.max(1, r.confirmMinutes)) {
      inc.detectedAt = row.minute + MIN;
      this.markUnstable(inc);
    }
    if (
      inc.detectedAt !== undefined &&
      inc.escalatedAt === undefined &&
      row.minute + MIN >= inc.detectedAt + r.pushDelayMinutes * MIN
    ) {
      inc.escalatedAt = inc.detectedAt + r.pushDelayMinutes * MIN;
    }
    if (inc.detectedAt !== undefined) {
      this.dirty.add(inc.id);
    }
    if (this.isDead(key)) {
      inc.chronic = true;
    }
  }

  private newIncident(row: BadMinuteRow): Incident {
    const key = channelKey(row.pid, row.cid);
    const previous = [...this.incidents]
      .reverse()
      .find((i) => channelKey(i.pid, i.cid) === key && i.detectedAt !== undefined);
    const reopen =
      previous?.closedAt !== undefined && row.minute - previous.closedAt <= this.rules.cooldownMinutes * MIN
        ? previous.id
        : undefined;
    this.seq += 1;
    return {
      id: `inc-${this.seq}`,
      pid: row.pid,
      provider: '',
      cid: row.cid,
      title: row.title,
      start: row.minute,
      lastBad: row.minute,
      badMinutes: 0,
      peakUsers: 0,
      peakErrUsers: 0,
      peakErrShare: 0,
      errEvents: 0,
      srvErrUsersMax: 0,
      series: [],
      paths: {},
      hosts: {},
      platforms: {},
      codes: {},
      chronic: false,
      unstable: false,
      cleanStreak: 0,
      reopenOf: reopen,
    };
  }

  /**
   * A confirmed incident on a channel that already failed recently joins (or
   * starts) an unstable series: either the previous incident is in a series
   * that has not settled for the flap window yet, or this is the flapCount-th
   * confirmed incident inside the window.
   */
  private markUnstable(inc: Incident) {
    const window = Math.max(1, this.rules.flapWindowMinutes) * MIN;
    const previous = this.incidents.filter(
      (i) => i !== inc && i.pid === inc.pid && i.cid === inc.cid && i.detectedAt !== undefined && i.start < inc.start
    );
    const last = previous[previous.length - 1];
    if (last?.episodeId && inc.start - (last.closedAt ?? last.lastBad + MIN) <= window) {
      inc.unstable = true;
      inc.episodeId = last.episodeId;
      return;
    }
    const recent = previous.filter((i) => i.start >= inc.start - window);
    if (recent.length + 1 >= Math.max(2, this.rules.flapCount)) {
      inc.unstable = true;
      inc.episodeId = `ep-${inc.id}`;
    }
  }

  /** When an unstable series settled (no failure for the flap window), or undefined while it has not. */
  private episodeEnd(episodeId: string): number | undefined {
    const members = this.incidents.filter((i) => i.episodeId === episodeId);
    if (!members.length || members.some((i) => i.closedAt === undefined)) {
      return undefined;
    }
    const end = Math.max(...members.map((i) => i.closedAt!)) + Math.max(1, this.rules.flapWindowMinutes) * MIN;
    return end <= this.clock ? end : undefined;
  }

  /**
   * Move the clock. A single failing minute that did not confirm expires as
   * noise after the recovery window; a confirmed incident without any clean
   * minute is closed silently after the quiet window.
   */
  advance(clock: number) {
    this.clock = Math.max(this.clock, clock);
    const blipWindow = (1 + Math.max(0, this.rules.recoveryMinutes)) * MIN;
    const quietWindow = MIN + Math.max(1, this.rules.quietCloseMinutes) * MIN;
    for (const [key, inc] of this.open) {
      if (inc.detectedAt === undefined) {
        if (inc.lastBad + blipWindow <= this.clock) {
          this.open.delete(key);
          this.incidents = this.incidents.filter((i) => i.id !== inc.id);
          this.blips += 1;
        }
      } else if (inc.lastBad + quietWindow <= this.clock) {
        inc.closedAt = inc.lastBad + quietWindow;
        inc.recovered = false;
        this.open.delete(key);
      }
    }
  }

  /**
   * Incidents whose viewer list must be (re)read: confirmed and touched since
   * the last fetch. The window spans the whole incident so the result
   * replaces the previous one.
   */
  takeIncidentWindows(): IncidentWindow[] {
    const windows: IncidentWindow[] = [];
    for (const id of this.dirty) {
      const inc = this.incidents.find((i) => i.id === id);
      if (inc && inc.detectedAt !== undefined) {
        windows.push({
          id,
          pid: inc.pid,
          cid: inc.cid,
          start: inc.start,
          end: Math.min(this.clock, inc.lastBad + MIN),
        });
      }
    }
    this.dirty.clear();
    return windows;
  }

  setAffectedUsers(incidentId: string, rows: AffectedUserRow[]) {
    this.affected.set(incidentId, rows);
  }

  /** Feed one chunk's per-channel health; refreshes the dead-channel set. */
  ingestChannelHealth(rows: ChannelHealthRow[], from: number, to: number) {
    for (const row of rows) {
      const key = channelKey(row.pid, row.cid);
      const entry = this.health.get(key) ?? { row, samples: [] };
      entry.row = row;
      entry.samples.push({
        from,
        to,
        srvErrUsers: row.srvErrUsers,
        okUsers: row.okUsers,
        triedUsers: row.triedUsers,
      });
      this.health.set(key, entry);
    }
    // Clean viewing is only reported for channels that also had server
    // errors (the query keeps srv > 0), so a chunk with no row means "no
    // evidence" and keeps the window going; the window simply slides on.
    for (const [key, entry] of this.health) {
      entry.samples = entry.samples.filter((s) => s.to > to - DEAD_WINDOW_SEC);
      const srv = entry.samples.reduce((sum, s) => sum + s.srvErrUsers, 0);
      const ok = entry.samples.reduce((sum, s) => sum + s.okUsers, 0);
      const tried = entry.samples.reduce((sum, s) => sum + s.triedUsers, 0);
      if (!entry.samples.length) {
        this.health.delete(key);
        continue;
      }
      if (srv >= DEAD_MIN_SRV_USERS && ok === 0) {
        const existing = this.dead.get(key);
        this.dead.set(key, {
          pid: entry.row.pid,
          provider: '',
          cid: entry.row.cid,
          title: entry.row.title,
          srvErrUsers: Math.max(existing?.srvErrUsers ?? 0, srv),
          triedUsers: Math.max(existing?.triedUsers ?? 0, tried),
          firstSeen: existing?.firstSeen ?? Math.min(...entry.samples.map((s) => s.from)),
          lastSeen: to,
        });
        const inc = this.open.get(key);
        if (inc) {
          inc.chronic = true;
        }
      }
    }
  }

  private isDead(key: string): boolean {
    const dead = this.dead.get(key);
    return Boolean(dead && dead.lastSeen >= this.clock - DEAD_WINDOW_SEC);
  }

  /**
   * Customer-side rows, one per viewer and UTC day: the live mode re-reads an
   * overlapping trailing window, so a newer row for the same viewer replaces
   * the older one instead of being added.
   */
  ingestCustomerSide(rows: CustomerSideRow[]) {
    for (const row of rows) {
      const key = `${row.pid}|${row.userId}|${Math.floor(row.lastMinute / DAY)}`;
      const existing = this.customer.get(key);
      if (!existing || row.lastMinute >= existing.lastMinute) {
        this.customer.set(key, row);
      }
    }
  }

  ingestErrorVolume(row: ErrorVolumeRow) {
    this.volume.errEvents += row.errEvents;
    this.volume.errUsers += row.errUsers;
    this.volume.userErrMinutes += row.userErrMinutes;
  }

  incidentClass(inc: Incident): IncidentClass {
    if (inc.chronic) {
      return 'chronic';
    }
    if (inc.unstable) {
      return 'unstable';
    }
    if (inc.escalatedAt !== undefined) {
      return 'push';
    }
    return inc.closedAt === undefined ? 'pending' : 'in_app';
  }

  /** Confirmed incidents, newest first, with provider names filled in. */
  getIncidents(): Incident[] {
    const groups = this.groupOf();
    return this.incidents
      .filter((i) => i.detectedAt !== undefined)
      .map((i) => ({ ...i, provider: this.providerName(i.pid), groupId: groups.get(i.id) }))
      .sort((a, b) => b.start - a.start);
  }

  getAffectedUsers(incidentId: string): AffectedUserRow[] {
    return this.affected.get(incidentId) ?? [];
  }

  getDeadChannels(): DeadChannel[] {
    return [...this.dead.values()]
      .map((d) => ({ ...d, provider: this.providerName(d.pid) }))
      .sort((a, b) => b.srvErrUsers - a.srvErrUsers);
  }

  getCustomerSide(): CustomerSideRow[] {
    return [...this.customer.values()]
      .map((c) => ({ ...c, provider: this.providerName(c.pid) }))
      .sort((a, b) => b.errEvents - a.errEvents);
  }

  // ---- Provider level ------------------------------------------------------

  /** Provider buckets of the same time on previous days (the baseline), for [from, to). */
  ingestProviderBaseline(rows: ProviderBucketRow[], from: number, to: number) {
    for (let b = Math.floor(from / PROVIDER_BUCKET_SEC) * PROVIDER_BUCKET_SEC; b < to; b += PROVIDER_BUCKET_SEC) {
      this.provCovered.add(b);
    }
    for (const row of rows) {
      this.provRows.set(`${row.pid}|${row.bucket}`, row);
    }
  }

  /**
   * Complete provider buckets of [from, to), compared with the baseline. They
   * also become the baseline of the days that follow.
   */
  ingestProviderBuckets(rows: ProviderBucketRow[], from: number, to: number) {
    this.ingestProviderBaseline(rows, from, to);
    this.clock = Math.max(this.clock, to);
    const byBucket = new Map<number, ProviderBucketRow[]>();
    for (const row of rows) {
      const list = byBucket.get(row.bucket) ?? [];
      list.push(row);
      byBucket.set(row.bucket, list);
    }
    for (let b = Math.floor(from / PROVIDER_BUCKET_SEC) * PROVIDER_BUCKET_SEC; b < to; b += PROVIDER_BUCKET_SEC) {
      const present = new Set<string>();
      for (const row of byBucket.get(b) ?? []) {
        present.add(row.pid);
        this.addProviderBucket(row);
      }
      for (const [pid, inc] of this.provOpen) {
        if (!present.has(pid) && b - inc.lastSurge >= PROVIDER_QUIET_SEC) {
          this.closeProvider(inc, inc.lastSurge + PROVIDER_BUCKET_SEC + PROVIDER_QUIET_SEC, false);
        }
      }
    }
  }

  /** True when every bucket of [from, to) was already read (no need to fetch it as baseline). */
  providerCoveredRange(from: number, to: number): boolean {
    for (let b = Math.floor(from / PROVIDER_BUCKET_SEC) * PROVIDER_BUCKET_SEC; b < to; b += PROVIDER_BUCKET_SEC) {
      if (!this.provCovered.has(b)) {
        return false;
      }
    }
    return true;
  }

  /** Median errors and error share of the same bucket on previous days; undefined without any day read. */
  providerBaseline(pid: string, bucket: number): { err: number; share: number; days: number } | undefined {
    const days = Math.min(7, Math.max(1, Math.round(this.rules.providerBaselineDays)));
    const errs: number[] = [];
    const shares: number[] = [];
    for (let d = 1; d <= days; d++) {
      const b = bucket - d * DAY;
      if (!this.provCovered.has(b)) {
        continue;
      }
      const row = this.provRows.get(`${pid}|${b}`);
      errs.push(row?.errUsers ?? 0);
      shares.push(row && row.users ? row.errUsers / row.users : 0);
    }
    if (!errs.length) {
      return undefined;
    }
    return { err: median(errs)!, share: median(shares)!, days: errs.length };
  }

  private addProviderBucket(row: ProviderBucketRow) {
    const r = this.rules;
    const base = this.providerBaseline(row.pid, row.bucket);
    let inc = this.provOpen.get(row.pid);
    if (!base) {
      return;
    }
    const share = row.users ? row.errUsers / row.users : 0;
    const surge =
      row.errUsers >= r.providerMinErrUsers &&
      row.errUsers >= r.providerSurgeFactor * Math.max(base.err, 1) &&
      row.errUsers - base.err >= r.providerMinErrUsers &&
      // A bigger audience (a match) brings more errors at the usual rate: not an outage.
      !(row.users > 0 && base.share > 0 && share < 1.5 * base.share);
    if (!surge) {
      if (inc) {
        if (inc.detectedAt !== undefined) {
          inc.series.push({ bucket: row.bucket, users: row.users, errUsers: row.errUsers, baselineErr: base.err });
        }
        this.closeProvider(inc, row.bucket + PROVIDER_BUCKET_SEC, true);
      }
      return;
    }
    if (!inc) {
      this.seq += 1;
      inc = {
        id: `prov-${this.seq}`,
        pid: row.pid,
        provider: '',
        start: row.bucket,
        lastSurge: row.bucket,
        surgeBuckets: 0,
        series: [],
        peakErrUsers: 0,
        peakBaselineErr: 0,
        peakRatio: 0,
        codes: {},
        platforms: {},
      };
      this.provOpen.set(row.pid, inc);
      this.provIncidents.push(inc);
    }
    inc.lastSurge = row.bucket;
    inc.surgeBuckets += 1;
    inc.series.push({ bucket: row.bucket, users: row.users, errUsers: row.errUsers, baselineErr: base.err });
    if (row.errUsers > inc.peakErrUsers) {
      inc.peakErrUsers = row.errUsers;
      inc.peakBaselineErr = base.err;
      inc.peakRatio = row.errUsers / Math.max(base.err, 1);
    }
    bump(inc.codes, row.topCode, row.errUsers);
    bump(inc.platforms, row.topPlatform, row.errUsers);
    if (inc.detectedAt === undefined && inc.surgeBuckets >= Math.max(1, r.providerConfirmBuckets)) {
      inc.detectedAt = row.bucket + PROVIDER_BUCKET_SEC;
    }
    if (inc.detectedAt !== undefined) {
      this.provDirty.add(inc.id);
    }
  }

  private closeProvider(inc: ProviderIncident, at: number, recovered: boolean) {
    this.provOpen.delete(inc.pid);
    if (inc.detectedAt === undefined) {
      // A single surging bucket that did not confirm.
      this.provIncidents = this.provIncidents.filter((i) => i.id !== inc.id);
      return;
    }
    inc.closedAt = at;
    inc.recovered = recovered;
  }

  /** Provider incidents whose viewers must be (re)read. */
  takeProviderWindows(): ProviderWindow[] {
    const windows: ProviderWindow[] = [];
    for (const id of this.provDirty) {
      const inc = this.provIncidents.find((i) => i.id === id);
      if (inc) {
        windows.push({ id, pid: inc.pid, start: inc.start, end: inc.lastSurge + PROVIDER_BUCKET_SEC });
      }
    }
    this.provDirty.clear();
    return windows;
  }

  setProviderAffected(incidentId: string, rows: AffectedUserRow[]) {
    this.provAffected.set(incidentId, rows);
  }

  getProviderAffected(incidentId: string): AffectedUserRow[] {
    return this.provAffected.get(incidentId) ?? [];
  }

  /** Several providers surging at once: shared infrastructure (a data centre, a network). */
  private providerGroupOf(): Map<string, string> {
    const confirmed = this.provIncidents.filter((i) => i.detectedAt !== undefined);
    const result = new Map<string, string>();
    const sorted = [...confirmed].sort((a, b) => a.start - b.start);
    let group: ProviderIncident[] = [];
    const flush = () => {
      if (new Set(group.map((g) => g.pid)).size > 1) {
        group.forEach((g) => result.set(g.id, `infra-${group[0].id}`));
      }
    };
    for (const inc of sorted) {
      if (group.length && inc.start - group[0].start > INFRA_ONSET_SEC) {
        flush();
        group = [];
      }
      group.push(inc);
    }
    flush();
    return result;
  }

  getProviderIncidents(): ProviderIncident[] {
    const groups = this.providerGroupOf();
    return this.provIncidents
      .filter((i) => i.detectedAt !== undefined)
      .map((i) => ({ ...i, provider: this.providerName(i.pid), groupId: groups.get(i.id) }))
      .sort((a, b) => b.start - a.start);
  }

  /**
   * Every message the rules would send (and every one they deliberately
   * hold back), in time order. Recomputed from scratch each call, so later
   * viewer lists replace earlier ones without double counting.
   */
  getDecisions(): Decision[] {
    const r = this.rules;
    const decisions: Decision[] = [];
    const cooldown = r.cooldownMinutes * MIN;
    /** Last "down"/"unstable" per viewer and channel, and per viewer and outage group. */
    const told = new Map<string, number>();
    /** Viewers told about an outage group: their single "back" waits for the whole group. */
    const groupTold = new Map<string, { seen: Decision; watchedBeforeSec: number }>();
    /** Viewers told a channel is unstable: one "stable again" when the series settles. */
    const episodeTold = new Map<string, Decision>();
    const groups = this.groupOf();
    const confirmed = this.incidents
      .filter((i) => i.detectedAt !== undefined)
      .sort((a, b) => (a.detectedAt ?? 0) - (b.detectedAt ?? 0));
    const byId = new Map(confirmed.map((i) => [i.id, i]));
    const providerIncidents = this.provIncidents
      .filter((i) => i.detectedAt !== undefined)
      .sort((a, b) => a.detectedAt! - b.detectedAt!);
    /** When each viewer would first hear about a provider-wide problem. */
    const providerPlan = new Map<string, number>();
    for (const inc of providerIncidents) {
      for (const u of this.provAffected.get(inc.id) ?? []) {
        const at = Math.max(u.firstErr, inc.detectedAt!);
        const key = `${inc.pid}|${u.userId}`;
        providerPlan.set(key, Math.min(providerPlan.get(key) ?? Infinity, at));
      }
    }
    /** Last channel-level "down"/"unstable" per provider and viewer. */
    const toldUser = new Map<string, number>();
    const toldAboutService = (pid: string, userId: string, at: number) => {
      const p = providerPlan.get(`${pid}|${userId}`);
      return p !== undefined && p <= at && at - p < cooldown ? p : undefined;
    };

    for (const inc of confirmed) {
      const detectedAt = inc.detectedAt!;
      const provider = this.providerName(inc.pid);
      const base = { pid: inc.pid, provider, cid: inc.cid, title: inc.title, incidentId: inc.id };
      const groupId = groups.get(inc.id);
      for (const user of this.affected.get(inc.id) ?? []) {
        const seen: Decision = {
          ...base,
          userId: user.userId,
          platform: user.platform,
          kind: 'down',
          at: 0,
          reason: '',
        };
        if (inc.chronic) {
          if (user.lastErr >= detectedAt) {
            decisions.push({
              ...seen,
              kind: 'in_app',
              at: Math.max(user.firstErr, detectedAt),
              reason: 'Channel unavailable for hours: status in the app, no push',
            });
          }
          continue;
        }
        const channelKeyOf = `ch|${inc.pid}|${inc.cid}|${user.userId}`;

        if (inc.unstable && inc.episodeId) {
          const at = Math.max(user.firstErr, detectedAt);
          const key = `${inc.episodeId}|${user.userId}`;
          if (episodeTold.has(key)) {
            decisions.push({ ...seen, kind: 'suppressed', at, reason: 'Already told the channel is unstable' });
            continue;
          }
          const service = toldAboutService(inc.pid, user.userId, at);
          if (service !== undefined) {
            decisions.push({
              ...seen,
              kind: 'suppressed',
              at,
              reason: `Already told about service problems ${Math.round((at - service) / MIN)} min ago`,
            });
            continue;
          }
          episodeTold.set(key, seen);
          told.set(channelKeyOf, at);
          toldUser.set(`${inc.pid}|${user.userId}`, at);
          decisions.push({
            ...seen,
            kind: 'unstable',
            at,
            reason: `Channel unstable: ${r.flapCount}+ failures within ${r.flapWindowMinutes} min, being fixed`,
          });
          continue;
        }

        if (inc.escalatedAt === undefined) {
          if (user.lastErr >= detectedAt) {
            decisions.push({
              ...seen,
              kind: 'in_app',
              at: Math.max(user.firstErr, detectedAt),
              reason:
                inc.closedAt === undefined
                  ? 'Incident too young for a push: message in the player on retry'
                  : 'Blip ended before a push was due: message in the player on retry',
            });
          }
          continue;
        }

        const at = Math.max(user.firstErr, inc.escalatedAt);
        const groupKey = groupId ? `grp|${groupId}|${user.userId}` : undefined;
        const previous = told.get(channelKeyOf);
        if (previous !== undefined && at - previous < cooldown) {
          decisions.push({
            ...seen,
            kind: 'suppressed',
            at,
            reason: `Already told about this channel ${Math.round((at - previous) / MIN)} min ago`,
          });
          continue;
        }
        const service = toldAboutService(inc.pid, user.userId, at);
        if (service !== undefined) {
          decisions.push({
            ...seen,
            kind: 'suppressed',
            at,
            reason: `Already told about service problems ${Math.round((at - service) / MIN)} min ago`,
          });
          continue;
        }
        if (groupKey && told.has(groupKey)) {
          decisions.push({
            ...seen,
            kind: 'suppressed',
            at,
            reason: 'Already told about the outage that took down several channels at once',
          });
          continue;
        }
        told.set(channelKeyOf, at);
        toldUser.set(`${inc.pid}|${user.userId}`, at);
        if (groupKey) {
          told.set(groupKey, at);
          groupTold.set(groupKey, { seen, watchedBeforeSec: user.watchedBeforeSec });
        }
        decisions.push({
          ...seen,
          kind: 'down',
          at,
          reason: groupKey
            ? 'Several channels down at once on the operator side, being fixed'
            : 'Channel down on the operator side, being fixed',
        });
        if (user.errEvents > 1) {
          decisions.push({
            ...seen,
            kind: 'suppressed',
            at: user.lastErr,
            reason: `${user.errEvents - 1} repeated errors in the same incident, no new message`,
          });
        }
        if (!groupKey && inc.closedAt !== undefined && inc.recovered) {
          decisions.push({
            ...seen,
            kind: 'back',
            at: inc.closedAt,
            reason: 'Channel is back: watched without errors again',
          });
          if (user.watchedBeforeSec >= r.apologyWatchMinutes * MIN) {
            decisions.push({
              ...seen,
              kind: 'apology',
              at: inc.closedAt,
              reason: `Watched ${Math.round(user.watchedBeforeSec / MIN)} min of the channel in the hour before`,
            });
          }
        }
      }
    }

    // One "back" per viewer and outage group, once every channel of the
    // group is closed and at least one recovered on clean viewing.
    for (const [key, { seen, watchedBeforeSec }] of groupTold) {
      const groupId = key.split('|')[1];
      const members = [...groups].filter(([, g]) => g === groupId).map(([id]) => byId.get(id)!);
      if (!members.length || members.some((m) => m.closedAt === undefined) || !members.some((m) => m.recovered)) {
        continue;
      }
      const at = Math.max(...members.map((m) => m.closedAt!));
      decisions.push({ ...seen, kind: 'back', at, reason: 'All channels of the outage are back' });
      if (watchedBeforeSec >= r.apologyWatchMinutes * MIN) {
        decisions.push({
          ...seen,
          kind: 'apology',
          at,
          reason: `Watched ${Math.round(watchedBeforeSec / MIN)} min of the channel in the hour before`,
        });
      }
    }

    for (const [key, seen] of episodeTold) {
      const end = this.episodeEnd(key.split('|')[0]);
      if (end !== undefined) {
        decisions.push({
          ...seen,
          kind: 'back',
          at: end,
          reason: `Channel stable again: no failure for ${r.flapWindowMinutes} min`,
        });
      }
    }

    // Provider-wide problems: one message per viewer who hit an error while
    // the provider surged, unless a channel message reached them first.
    const lastService = new Map<string, number>();
    for (const inc of providerIncidents) {
      const provider = this.providerName(inc.pid);
      for (const u of this.provAffected.get(inc.id) ?? []) {
        const at = Math.max(u.firstErr, inc.detectedAt!);
        const key = `${inc.pid}|${u.userId}`;
        const seen: Decision = {
          kind: 'down',
          at,
          userId: u.userId,
          pid: inc.pid,
          provider,
          cid: '',
          // Provider-wide: no single channel (the UI labels it "All channels").
          title: '',
          incidentId: inc.id,
          platform: u.platform,
          reason: '',
        };
        const channel = toldUser.get(key);
        if (channel !== undefined && channel < at && at - channel < cooldown) {
          decisions.push({
            ...seen,
            kind: 'suppressed',
            reason: `Already told about a channel outage ${Math.round((at - channel) / MIN)} min ago`,
          });
          continue;
        }
        const previous = lastService.get(key);
        if (previous !== undefined && at - previous < cooldown) {
          decisions.push({
            ...seen,
            kind: 'suppressed',
            reason: `Already told about service problems ${Math.round((at - previous) / MIN)} min ago`,
          });
          continue;
        }
        if (u.errEvents < r.providerMinViewerErrors || u.lastErr - u.firstErr < 2 * MIN) {
          decisions.push({
            ...seen,
            kind: 'in_app',
            reason: 'One-off error during service problems: message in the player on retry',
          });
          continue;
        }
        lastService.set(key, at);
        decisions.push({
          ...seen,
          reason: `Service problems on the operator side: ${inc.peakRatio.toFixed(1)}× the usual errors, being fixed`,
        });
        if (inc.closedAt !== undefined && inc.recovered) {
          decisions.push({ ...seen, kind: 'back', at: inc.closedAt, reason: 'Service back to its usual level' });
        }
      }
    }

    const lastDiagnosis = new Map<string, number>();
    for (const c of [...this.customer.values()].sort((a, b) => a.lastMinute - b.lastMinute)) {
      // During a provider-wide problem errors on "healthy" channels are the
      // operator's, not the viewer's home network.
      if (
        providerIncidents.some(
          (i) => i.pid === c.pid && i.start <= c.lastMinute + MIN && (i.closedAt ?? Infinity) > c.firstMinute
        )
      ) {
        continue;
      }
      const at = c.lastMinute + MIN;
      const key = `${c.pid}|${c.userId}`;
      const previous = lastDiagnosis.get(key);
      if (previous !== undefined && at - previous < DIAGNOSIS_COOLDOWN_SEC) {
        continue;
      }
      lastDiagnosis.set(key, at);
      decisions.push({
        kind: 'diagnosis',
        at,
        userId: c.userId,
        pid: c.pid,
        provider: this.providerName(c.pid),
        cid: '',
        title: `${c.channels} channels`,
        platform: c.platform,
        reason: `Errors on ${c.channels} channels over ${c.minutes} min while they worked for others (${[c.network || 'unknown network', c.isp, c.topCode].filter(Boolean).join(', ')})`,
      });
    }

    return decisions.sort((a, b) => a.at - b.at);
  }

  /** Incidents that share a source stream, or one origin directory with a common onset. */
  getGroups(): CorrelationGroup[] {
    const groups = new Map<string, CorrelationGroup>();
    const byId = new Map(this.incidents.map((i) => [i.id, i]));
    for (const [incId, groupId] of this.groupOf()) {
      const group = groups.get(groupId) ?? { id: groupId, label: '', incidentIds: [] };
      group.incidentIds.push(incId);
      groups.set(groupId, group);
    }
    for (const group of groups.values()) {
      const members = group.incidentIds.map((id) => byId.get(id)!).filter(Boolean);
      const pids = new Set(members.map((m) => m.pid));
      const paths = new Set(members.map((m) => topKey(m.paths)));
      group.label =
        paths.size === 1
          ? `Same source ${[...paths][0]} on ${pids.size} provider${pids.size > 1 ? 's' : ''}`
          : `Same origin ${parentPath(topKey(members[0].paths)) || topKey(members[0].hosts)}: ${members.length} channels on ${pids.size} provider${pids.size > 1 ? 's' : ''}`;
    }
    return [...groups.values()];
  }

  private groupOf(): Map<string, string> {
    const confirmed = this.incidents.filter((i) => i.detectedAt !== undefined);
    const parent = new Map<string, string>(confirmed.map((i) => [i.id, i.id]));
    const find = (id: string): string => {
      let root = id;
      while (parent.get(root) !== root) {
        root = parent.get(root)!;
      }
      parent.set(id, root);
      return root;
    };
    const end = (i: Incident) => (i.recovered === false ? i.lastBad + MIN : (i.closedAt ?? i.lastBad + MIN));
    for (let a = 0; a < confirmed.length; a++) {
      for (let b = a + 1; b < confirmed.length; b++) {
        const x = confirmed[a];
        const y = confirmed[b];
        if (x.start >= end(y) || y.start >= end(x)) {
          continue;
        }
        const px = topKey(x.paths);
        const py = topKey(y.paths);
        const sameSource = px !== '' && px === py && (x.pid !== y.pid || x.cid !== y.cid);
        const sameOrigin =
          x.pid === y.pid &&
          parentPath(px) !== '' &&
          parentPath(px) === parentPath(py) &&
          Math.abs(x.start - y.start) <= ORIGIN_ONSET_SEC;
        if (sameSource || sameOrigin) {
          parent.set(find(x.id), find(y.id));
        }
      }
    }
    const counts = new Map<string, number>();
    for (const i of confirmed) {
      const root = find(i.id);
      counts.set(root, (counts.get(root) ?? 0) + 1);
    }
    const result = new Map<string, string>();
    for (const i of confirmed) {
      const root = find(i.id);
      if ((counts.get(root) ?? 0) > 1) {
        result.set(i.id, `grp-${root}`);
      }
    }
    return result;
  }

  /**
   * Channels across the whole run, for the ops report: recurring problems
   * (incidents on several days), unstable series and channels that look
   * off-air rather than broken (everyone failing, nobody watching after).
   */
  getChannelReport(): ChannelReportRow[] {
    const rows = new Map<
      string,
      ChannelReportRow & {
        _days: Set<string>;
        _paths: Record<string, number>;
        _platforms: Record<string, number>;
        _codes: Record<string, number>;
      }
    >();
    for (const inc of this.incidents) {
      if (inc.detectedAt === undefined) {
        continue;
      }
      const key = channelKey(inc.pid, inc.cid);
      const row = rows.get(key) ?? {
        pid: inc.pid,
        provider: this.providerName(inc.pid),
        cid: inc.cid,
        title: inc.title,
        incidents: 0,
        days: 0,
        failingMinutes: 0,
        viewersHit: 0,
        pushIncidents: 0,
        unstableIncidents: 0,
        offAir: 0,
        dead: this.dead.has(key),
        topPath: '',
        topPlatform: '',
        topCode: '',
        firstStart: inc.start,
        lastStart: inc.start,
        _days: new Set<string>(),
        _paths: {},
        _platforms: {},
        _codes: {},
      };
      const cls = this.incidentClass(inc);
      row.incidents += 1;
      row._days.add(new Date(inc.start * 1000).toISOString().slice(0, 10));
      row.failingMinutes += inc.badMinutes;
      row.viewersHit += (this.affected.get(inc.id) ?? []).length;
      row.pushIncidents += cls === 'push' ? 1 : 0;
      row.unstableIncidents += cls === 'unstable' ? 1 : 0;
      row.offAir += inc.recovered === false && inc.peakErrShare >= 0.9 ? 1 : 0;
      row.firstStart = Math.min(row.firstStart, inc.start);
      row.lastStart = Math.max(row.lastStart, inc.start);
      for (const [k, v] of Object.entries(inc.paths)) {
        bump(row._paths, k, v);
      }
      for (const [k, v] of Object.entries(inc.platforms)) {
        bump(row._platforms, k, v);
      }
      for (const [k, v] of Object.entries(inc.codes)) {
        bump(row._codes, k, v);
      }
      rows.set(key, row);
    }
    return [...rows.values()]
      .map(({ _days, _paths, _platforms, _codes, ...row }) => ({
        ...row,
        days: _days.size,
        topPath: topKey(_paths),
        topPlatform: topKey(_platforms),
        topCode: topKey(_codes),
      }))
      .sort((a, b) => b.viewersHit - a.viewersHit);
  }

  getSummary(): AlertSummary {
    const incidents = this.incidents.filter((i) => i.detectedAt !== undefined);
    const decisions = this.getDecisions();
    const count = (kind: Decision['kind']) => decisions.filter((d) => d.kind === kind).length;
    const lags: number[] = [];
    let repeats = 0;
    for (const inc of incidents) {
      for (const u of this.affected.get(inc.id) ?? []) {
        if (u.firstErr < inc.detectedAt!) {
          lags.push((inc.detectedAt! - u.firstErr) / MIN);
        }
        if (inc.escalatedAt !== undefined && !inc.chronic) {
          repeats += Math.max(0, u.errEvents - 1);
        }
      }
    }
    const classes = incidents.map((i) => this.incidentClass(i));
    return {
      incidents: incidents.length,
      providerIncidents: this.provIncidents.filter((i) => i.detectedAt !== undefined).length,
      infraGroups: new Set(this.providerGroupOf().values()).size,
      pushIncidents: classes.filter((c) => c === 'push').length,
      unstableIncidents: classes.filter((c) => c === 'unstable').length,
      inAppIncidents: classes.filter((c) => c === 'in_app').length,
      chronicIncidents: classes.filter((c) => c === 'chronic').length,
      openIncidents: incidents.filter((i) => i.closedAt === undefined).length,
      down: count('down'),
      unstable: count('unstable'),
      back: count('back'),
      apology: count('apology'),
      inApp: count('in_app'),
      suppressedRepeats: repeats,
      suppressedCooldown: decisions.filter((d) => d.kind === 'suppressed' && d.reason.startsWith('Already told'))
        .length,
      diagnoses: count('diagnosis'),
      deadChannels: this.dead.size,
      naiveErrEvents: this.volume.errEvents,
      naiveUserMinutes: this.volume.userErrMinutes,
      medianDetectLagMin: median(lags),
    };
  }

  /** Single bad minutes that never confirmed into an incident. */
  get blipCount(): number {
    return this.blips;
  }
}
