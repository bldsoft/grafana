// Analytix: AI Insider Alerts - app-level detection, per provider and 5
// minutes against the same time on previous days. Catches what player errors
// do not show (checked on the 2026 postmortems): a middleware or login outage
// (app starts pile up, playback stops, often without one player error), a data
// centre taking many providers down at once, and the analytics intake itself
// going silent with it. Plain TypeScript, no Grafana imports: it moves to a
// server-side runner as is.

import { ACTIVITY_BUCKET_SEC } from './sql';
import type { ActivityBucketRow, ActivityIncident, ActivityKind, ActivitySample, AlertRules } from './types';

const DAY = 86400;
const B = ACTIVITY_BUCKET_SEC;

/** A provider counts towards "no data" only where it usually sends this many events per 5 minutes. */
const SILENT_MIN_BASE_EVENTS = 300;
/**
 * What makes one provider abnormal inside a cross-provider outage. Looser than
 * the single-provider rule on purpose: the outage needs many providers at once,
 * which is what keeps it quiet on normal days (0 false alarms in 13 days).
 */
const MEMBER_MIN_BASE_PLAYS = 60;
const MEMBER_PLAY_SHARE = 0.4;
const MEMBER_MIN_ERRORS = 30;
const MEMBER_ERROR_FACTOR = 5;
const MEMBER_MIN_BASE_SESSIONS = 10;
const MEMBER_STORM_FACTOR = 2.5;
const MEMBER_STORM_PLAY_SHARE = 0.8;
/** Single-provider "service down" needs a usual level worth comparing with. */
const SERVICE_MIN_BASE_SESSIONS = 8;
const SERVICE_MIN_BASE_PLAYS = 50;
const OUTAGE_CONFIRM_BUCKETS = 2;
/** Normal periods in a row that close an incident (no_data closes on the first one). */
const CLOSE_AFTER_BUCKETS = 3;
/** An outage dips and returns (03.04: 08:35 and 09:05): it holds for half an hour. */
const OUTAGE_CLOSE_AFTER_BUCKETS = 6;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface Baseline {
  sessions: number;
  plays: number;
  errEvents: number;
  events: number;
}

interface Track {
  inc: ActivityIncident;
  /** Abnormal buckets in a row before confirmation. */
  streak: number;
  /** Normal buckets in a row after confirmation. */
  quiet: number;
}

const ZERO = (bucket: number, pid: string): ActivityBucketRow => ({
  bucket,
  pid,
  users: 0,
  sessions: 0,
  plays: 0,
  errEvents: 0,
  events: 0,
});

export class ActivityDetector {
  private rules: AlertRules;
  /** Buckets read so far (window and baseline days), by pid|bucket. */
  private rows = new Map<string, ActivityBucketRow>();
  /** Buckets whose rows were read: a missing row there means "no events". */
  private covered = new Set<number>();
  /** Every provider seen in any bucket: a silent one has no row at all. */
  private pids = new Set<string>();
  private incidents: ActivityIncident[] = [];
  private open = new Map<string, Track>();
  private seq = 0;
  /** Buckets are evaluated up to here (complete buckets only). */
  watermark?: number;

  constructor(rules: AlertRules) {
    this.rules = rules;
  }

  private baselineDays(): number {
    return Math.min(7, Math.max(1, Math.round(this.rules.providerBaselineDays)));
  }

  /** True when every bucket of [from, to) was already read. */
  coveredRange(from: number, to: number): boolean {
    for (let b = Math.floor(from / B) * B; b < to; b += B) {
      if (!this.covered.has(b)) {
        return false;
      }
    }
    return true;
  }

  /** Buckets of the same time on previous days (the baseline), for [from, to). */
  ingestBaseline(rows: ActivityBucketRow[], from: number, to: number) {
    for (let b = Math.floor(from / B) * B; b < to; b += B) {
      this.covered.add(b);
    }
    for (const row of rows) {
      if (row.pid) {
        this.rows.set(`${row.pid}|${row.bucket}`, row);
        this.pids.add(row.pid);
      }
    }
  }

  /** Complete buckets of [from, to), compared with the baseline; they also become the baseline of later days. */
  ingest(rows: ActivityBucketRow[], from: number, to: number) {
    this.ingestBaseline(rows, from, to);
    for (let b = Math.floor(from / B) * B; b + B <= to; b += B) {
      this.evaluate(b);
    }
  }

  /** Median of the same bucket on previous days; undefined without any day read. */
  baseline(pid: string, bucket: number): Baseline | undefined {
    const days: ActivityBucketRow[] = [];
    for (let d = 1; d <= this.baselineDays(); d++) {
      const b = bucket - d * DAY;
      if (this.covered.has(b)) {
        days.push(this.rows.get(`${pid}|${b}`) ?? ZERO(b, pid));
      }
    }
    if (!days.length) {
      return undefined;
    }
    return {
      sessions: median(days.map((r) => r.sessions)),
      plays: median(days.map((r) => r.plays)),
      errEvents: median(days.map((r) => r.errEvents)),
      events: median(days.map((r) => r.events)),
    };
  }

  private evaluate(bucket: number) {
    const r = this.rules;
    const silent: string[] = [];
    const abnormal: string[] = [];
    const sum = (list: string[]) => {
      const s: ActivitySample = {
        bucket,
        sessions: 0,
        plays: 0,
        errEvents: 0,
        events: 0,
        baseSessions: 0,
        basePlays: 0,
        baseErrEvents: 0,
        baseEvents: 0,
        providers: list.length,
      };
      for (const pid of list) {
        const row = this.rows.get(`${pid}|${bucket}`) ?? ZERO(bucket, pid);
        const base = this.baseline(pid, bucket)!;
        s.sessions += row.sessions;
        s.plays += row.plays;
        s.errEvents += row.errEvents;
        s.events += row.events;
        s.baseSessions += base.sessions;
        s.basePlays += base.plays;
        s.baseErrEvents += base.errEvents;
        s.baseEvents += base.events;
      }
      return s;
    };

    const service: Array<{ pid: string; storm: boolean; sample: () => ActivitySample }> = [];
    for (const pid of this.pids) {
      const base = this.baseline(pid, bucket);
      if (!base) {
        continue;
      }
      const row = this.rows.get(`${pid}|${bucket}`) ?? ZERO(bucket, pid);
      if (base.events >= SILENT_MIN_BASE_EVENTS && row.events === 0) {
        silent.push(pid);
        continue;
      }
      const drop = base.plays >= MEMBER_MIN_BASE_PLAYS && row.plays <= MEMBER_PLAY_SHARE * base.plays;
      const errors =
        row.errEvents >= MEMBER_MIN_ERRORS && row.errEvents >= MEMBER_ERROR_FACTOR * Math.max(base.errEvents, 5);
      const looseStorm =
        base.sessions >= MEMBER_MIN_BASE_SESSIONS &&
        row.sessions >= MEMBER_STORM_FACTOR * base.sessions &&
        row.plays <= MEMBER_STORM_PLAY_SHARE * base.plays;
      if (drop || errors || looseStorm) {
        abnormal.push(pid);
      }
      const eligible = base.sessions >= SERVICE_MIN_BASE_SESSIONS && base.plays >= SERVICE_MIN_BASE_PLAYS;
      // An open incident keeps being judged even if its usual level fell below the floor.
      if (eligible || this.open.has(`service_down|${pid}`)) {
        const storm =
          eligible &&
          row.sessions >= r.serviceStormFactor * base.sessions &&
          row.plays <= r.servicePlayShare * base.plays;
        service.push({ pid, storm, sample: () => sum([pid]) });
      }
    }

    const noData = silent.length >= Math.max(1, r.noDataMinProviders);
    this.step('no_data', '', noData, false, bucket, 1, 1, silent, () => sum(silent));
    // While the intake is silent nothing else can be judged: the bucket is neutral.
    const outage = abnormal.length >= Math.max(1, r.outageMinProviders);
    this.step('outage', '', outage, noData, bucket, OUTAGE_CONFIRM_BUCKETS, OUTAGE_CLOSE_AFTER_BUCKETS, abnormal, () =>
      sum(abnormal)
    );
    for (const s of service) {
      this.step(
        'service_down',
        s.pid,
        s.storm,
        noData,
        bucket,
        Math.max(1, Math.round(r.serviceConfirmBuckets)),
        CLOSE_AFTER_BUCKETS,
        [s.pid],
        s.sample
      );
    }
  }

  /** Advances one incident track by one bucket: open, extend, confirm, or close it. */
  private step(
    kind: ActivityKind,
    pid: string,
    abnormal: boolean,
    neutral: boolean,
    bucket: number,
    confirm: number,
    closeAfter: number,
    members: string[],
    sample: () => ActivitySample
  ) {
    const key = `${kind}|${pid}`;
    let track = this.open.get(key);
    if (neutral) {
      return;
    }
    if (abnormal) {
      if (!track) {
        this.seq += 1;
        track = {
          inc: {
            id: `act-${this.seq}`,
            kind,
            pid,
            provider: '',
            pids: {},
            start: bucket,
            lastSeen: bucket,
            series: [],
          },
          streak: 0,
          quiet: 0,
        };
        this.open.set(key, track);
        this.incidents.push(track.inc);
      }
      const { inc } = track;
      track.quiet = 0;
      inc.lastSeen = bucket;
      inc.series.push(sample());
      members.forEach((p) => (inc.pids[p] = (inc.pids[p] ?? 0) + 1));
      if (inc.detectedAt === undefined) {
        track.streak += 1;
        if (track.streak >= confirm) {
          inc.detectedAt = bucket + B;
        }
      }
      return;
    }
    if (!track) {
      return;
    }
    if (track.inc.detectedAt === undefined) {
      // Not confirmed: the abnormal periods were not in a row.
      this.open.delete(key);
      this.incidents = this.incidents.filter((i) => i !== track!.inc);
      return;
    }
    track.quiet += 1;
    if (track.inc.series.length < 200) {
      track.inc.series.push(sample());
    }
    if (track.quiet >= closeAfter) {
      track.inc.closedAt = track.inc.lastSeen + B;
      // The normal periods after the end were only kept for the chart's tail.
      this.open.delete(key);
    }
  }

  /**
   * Confirmed incidents, newest first. A provider's service outage inside a
   * cross-provider outage it is part of is that outage, not a separate one.
   */
  getIncidents(providerName: (pid: string) => string = () => ''): ActivityIncident[] {
    const confirmed = this.incidents.filter((i) => i.detectedAt !== undefined);
    const outages = confirmed.filter((i) => i.kind === 'outage');
    const overlaps = (a: ActivityIncident, b: ActivityIncident) =>
      a.start < (b.closedAt ?? Infinity) && b.start < (a.closedAt ?? Infinity);
    return confirmed
      .filter((i) => i.kind !== 'service_down' || !outages.some((o) => o.pids[i.pid] && overlaps(i, o)))
      .map((i) => ({ ...i, provider: i.pid ? providerName(i.pid) : '' }))
      .sort((a, b) => b.start - a.start);
  }

  /**
   * True when a confirmed incident covers this provider and time: errors of a
   * viewer then are the operator's, not their home network's.
   */
  covers(pid: string, from: number, to: number): boolean {
    return this.incidents.some(
      (i) =>
        i.detectedAt !== undefined &&
        // A data centre or intake outage covers everyone; a service outage its provider.
        (i.kind !== 'service_down' || i.pid === pid) &&
        i.start <= to &&
        (i.closedAt ?? Infinity) > from
    );
  }
}
