// Analytix: AI Insider Alerts - the decision engine. Pure TypeScript with no
// Grafana dependencies, so the same rules can later move to a server-side
// runner unchanged. It consumes query results chunk by chunk in time order
// (a replay of past days or the live tail) and answers two questions:
//   1. is a channel down on the operator side right now (an incident), and
//   2. which viewer would be told what, and when — or deliberately not told.

import type { IncidentWindow } from './sql';
import type {
  AffectedUserRow,
  AlertRules,
  AlertSummary,
  BadMinuteRow,
  ChannelHealthRow,
  CorrelationGroup,
  CustomerSideRow,
  DeadChannel,
  Decision,
  ErrorVolumeRow,
  Incident,
  IncidentClass,
} from './types';

const MIN = 60;
const DAY = 86400;
/** Window over which a channel with only server errors and no clean viewing counts as dead. */
const DEAD_WINDOW_SEC = 3 * 3600;
/** Server-error viewers needed in that window before a channel is called dead. */
const DEAD_MIN_SRV_USERS = 3;
/** Incidents on one origin directory belong together only when they start this close. */
const ORIGIN_ONSET_SEC = 5 * MIN;
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
  private seq = 0;
  /** End of the last processed window. */
  clock = 0;

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

  /** Feed the failing channel-minutes of one window, sorted by minute. */
  ingestBadMinutes(rows: BadMinuteRow[]) {
    const sorted = [...rows].sort((a, b) => a.minute - b.minute);
    for (const row of sorted) {
      // Recovery of other channels is confirmed as time passes, so the open
      // set always reflects "now" = this minute while walking the window.
      this.advance(row.minute);
      this.addBadMinute(row);
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
      reopenOf: reopen,
    };
  }

  /** Move the clock: confirm recovery of incidents that stayed clean long enough. */
  advance(clock: number) {
    this.clock = Math.max(this.clock, clock);
    const recovery = (1 + Math.max(0, this.rules.recoveryMinutes)) * MIN;
    for (const [key, inc] of this.open) {
      if (inc.lastBad + recovery <= this.clock) {
        inc.closedAt = inc.lastBad + recovery;
        this.open.delete(key);
        if (inc.detectedAt === undefined) {
          // A single bad minute that never confirmed: noise, not an incident.
          this.incidents = this.incidents.filter((i) => i.id !== inc.id);
          this.blips += 1;
        }
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

  /**
   * Every message the rules would send (and every one they deliberately
   * hold back), in time order. Recomputed from scratch each call, so later
   * viewer lists replace earlier ones without double counting.
   */
  getDecisions(): Decision[] {
    const r = this.rules;
    const decisions: Decision[] = [];
    const lastDown = new Map<string, number>();
    const confirmed = this.incidents
      .filter((i) => i.detectedAt !== undefined)
      .sort((a, b) => (a.detectedAt ?? 0) - (b.detectedAt ?? 0));

    for (const inc of confirmed) {
      const detectedAt = inc.detectedAt!;
      const provider = this.providerName(inc.pid);
      const base = { pid: inc.pid, provider, cid: inc.cid, title: inc.title, incidentId: inc.id };
      for (const user of this.affected.get(inc.id) ?? []) {
        const seen = { ...base, userId: user.userId, platform: user.platform };
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
        const key = `${inc.pid}|${inc.cid}|${user.userId}`;
        const previous = lastDown.get(key);
        if (previous !== undefined && at - previous < r.cooldownMinutes * MIN) {
          decisions.push({
            ...seen,
            kind: 'suppressed',
            at,
            reason: `Already told about this channel ${Math.round((at - previous) / MIN)} min ago`,
          });
          continue;
        }
        lastDown.set(key, at);
        decisions.push({ ...seen, kind: 'down', at, reason: 'Channel down on the operator side, being fixed' });
        if (user.errEvents > 1) {
          decisions.push({
            ...seen,
            kind: 'suppressed',
            at: user.lastErr,
            reason: `${user.errEvents - 1} repeated errors in the same incident, no new message`,
          });
        }
        if (inc.closedAt !== undefined) {
          decisions.push({ ...seen, kind: 'back', at: inc.closedAt, reason: 'Channel is back' });
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

    const lastDiagnosis = new Map<string, number>();
    for (const c of [...this.customer.values()].sort((a, b) => a.lastMinute - b.lastMinute)) {
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
        reason: `Errors on ${c.channels} channels over ${c.minutes} min while they worked for others (${c.network || 'unknown network'}, ${c.topCode})`,
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
          : `Same origin ${parentPath(topKey(members[0].paths)) || topKey(members[0].hosts)}: ${members.length} channels`;
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
    const end = (i: Incident) => i.closedAt ?? i.lastBad + MIN;
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
      pushIncidents: classes.filter((c) => c === 'push').length,
      inAppIncidents: classes.filter((c) => c === 'in_app').length,
      chronicIncidents: classes.filter((c) => c === 'chronic').length,
      openIncidents: incidents.filter((i) => i.closedAt === undefined).length,
      down: count('down'),
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
