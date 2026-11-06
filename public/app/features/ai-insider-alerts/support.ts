// The support view of a run: every confirmed problem (channel, provider-wide,
// app level) in one list, and a per-account index for "a viewer is on the
// phone, what happened to them". Pure functions over the engine snapshot.

import { accountKey } from './push/pushPlan';
import {
  CHANNEL_SEP,
  type ActivityIncident,
  type AffectedUserRow,
  type CustomerSideRow,
  type Decision,
  type Incident,
  type IncidentClass,
  type ProviderIncident,
  type ViewerDetail,
} from './types';

export type ProblemKind = 'channel' | 'unstable' | 'chronic' | 'provider' | 'service_down' | 'outage' | 'no_data';

export interface Problem {
  /** The id of the underlying incident (channel, `prov-…` or `act-…`). */
  id: string;
  source: 'channel' | 'provider' | 'activity';
  kind: ProblemKind;
  /** Channel title, provider, or "N providers" for the cross-provider kinds (filled by the view). */
  title: string;
  pid: string;
  provider: string;
  start: number;
  closedAt?: number;
  /** true = back to normal; false = went quiet without clean viewing; undefined while ongoing. */
  recovered?: boolean;
  ongoing: boolean;
  /** Distinct viewers with errors in it (0 for app-level problems: no per-viewer data). */
  viewers: number;
  /** Distinct viewers who got a message about it (push or in the player). */
  told: number;
  channel?: Incident;
  providerIncident?: ProviderIncident;
  activity?: ActivityIncident;
}

/** What the support view needs from the snapshot. */
export interface SupportInput {
  incidents: Incident[];
  providers: ProviderIncident[];
  activity: ActivityIncident[];
  decisions: Decision[];
  customer: CustomerSideRow[];
  classOf: (incident: Incident) => IncidentClass;
  affected: (incidentId: string) => AffectedUserRow[];
  providerAffected: (incidentId: string) => AffectedUserRow[];
}

/** Message kinds that tell a viewer about a problem (not "back", not held back). */
const TOLD_KINDS = new Set<Decision['kind']>(['down', 'service', 'unstable', 'in_app']);

/**
 * Messages of one viewer about one problem as support reads them, in time
 * order: "held back" only when nothing else went out (a held-back repeat
 * after a push is not news to the viewer).
 */
export function visibleMessages(messages: Decision[]): Decision[] {
  const sorted = [...messages].sort((a, b) => a.at - b.at);
  const sent = sorted.filter((m) => m.kind !== 'suppressed');
  return sent.length ? sent : sorted.slice(0, 1);
}

export function decisionsByIncident(decisions: Decision[]): Map<string, Decision[]> {
  const result = new Map<string, Decision[]>();
  for (const d of decisions) {
    if (d.incidentId) {
      const list = result.get(d.incidentId);
      if (list) {
        list.push(d);
      } else {
        result.set(d.incidentId, [d]);
      }
    }
  }
  return result;
}

function toldCount(decisions: Decision[] | undefined): number {
  return new Set((decisions ?? []).filter((d) => TOLD_KINDS.has(d.kind)).map((d) => d.userId)).size;
}

/**
 * Problems wider than one channel: a whole provider, the service or several
 * providers at once. They hit far more viewers than a channel does, so the
 * support view pins them above the stream of channel failures.
 */
export const MAJOR_KINDS: ReadonlySet<ProblemKind> = new Set<ProblemKind>([
  'provider',
  'service_down',
  'outage',
  'no_data',
]);

export function isMajor(p: Problem): boolean {
  return MAJOR_KINDS.has(p.kind);
}

/** Ongoing first (wide problems on top, chronic channels last), then the most recent. */
function rank(p: Problem): number {
  if (!p.ongoing) {
    return 3;
  }
  return isMajor(p) ? 0 : p.kind === 'chronic' ? 2 : 1;
}

export function buildProblems(input: SupportInput): Problem[] {
  const byIncident = decisionsByIncident(input.decisions);
  const problems: Problem[] = [];

  for (const inc of input.incidents) {
    if (inc.detectedAt === undefined) {
      continue;
    }
    const cls = input.classOf(inc);
    problems.push({
      id: inc.id,
      source: 'channel',
      kind: cls === 'chronic' ? 'chronic' : cls === 'unstable' ? 'unstable' : 'channel',
      title: inc.title || inc.cid,
      pid: inc.pid,
      provider: inc.provider,
      start: inc.start,
      closedAt: inc.closedAt,
      recovered: inc.closedAt === undefined ? undefined : inc.recovered !== false,
      ongoing: inc.closedAt === undefined,
      viewers: input.affected(inc.id).length,
      told: toldCount(byIncident.get(inc.id)),
      channel: inc,
    });
  }

  for (const p of input.providers) {
    if (p.detectedAt === undefined) {
      continue;
    }
    problems.push({
      id: p.id,
      source: 'provider',
      kind: 'provider',
      title: p.provider || p.pid,
      pid: p.pid,
      provider: p.provider,
      start: p.start,
      closedAt: p.closedAt,
      recovered: p.closedAt === undefined ? undefined : p.recovered !== false,
      ongoing: p.closedAt === undefined,
      viewers: input.providerAffected(p.id).length,
      told: toldCount(byIncident.get(p.id)),
      providerIncident: p,
    });
  }

  for (const a of input.activity) {
    if (a.detectedAt === undefined) {
      continue;
    }
    problems.push({
      id: a.id,
      source: 'activity',
      kind: a.kind,
      title: a.kind === 'service_down' ? a.provider || a.pid : '',
      pid: a.pid,
      provider: a.provider,
      start: a.start,
      closedAt: a.closedAt,
      recovered: a.closedAt === undefined ? undefined : true,
      ongoing: a.closedAt === undefined,
      viewers: 0,
      told: 0,
      activity: a,
    });
  }

  return problems.sort((a, b) => rank(a) - rank(b) || b.start - a.start);
}

/** One problem a viewer ran into, with what they were told about it. */
export interface ViewerHit {
  problem: Problem;
  row: AffectedUserRow;
  messages: Decision[];
}

export interface ViewerRecord {
  /** The account as the data spells it. */
  userId: string;
  hits: ViewerHit[];
  /** "Errors on channels that work for everyone else" days. */
  customer: CustomerSideRow[];
  /** Personal diagnoses (no incident). */
  diagnoses: Decision[];
}

/** Account key (as typed by support: trimmed, any case) → what happened to that viewer. */
export function buildViewerIndex(input: SupportInput, problems: Problem[]): Map<string, ViewerRecord> {
  const index = new Map<string, ViewerRecord>();
  const record = (userId: string): ViewerRecord => {
    const key = accountKey(userId);
    let r = index.get(key);
    if (!r) {
      r = { userId, hits: [], customer: [], diagnoses: [] };
      index.set(key, r);
    }
    return r;
  };

  const byIncidentUser = new Map<string, Decision[]>();
  for (const d of input.decisions) {
    if (!d.incidentId) {
      if (d.kind === 'diagnosis') {
        record(d.userId).diagnoses.push(d);
      }
      continue;
    }
    const key = `${d.incidentId}|${d.userId}`;
    const list = byIncidentUser.get(key);
    if (list) {
      list.push(d);
    } else {
      byIncidentUser.set(key, [d]);
    }
  }

  for (const problem of problems) {
    const rows =
      problem.source === 'channel'
        ? input.affected(problem.id)
        : problem.source === 'provider'
          ? input.providerAffected(problem.id)
          : [];
    for (const row of rows) {
      const messages = visibleMessages(byIncidentUser.get(`${problem.id}|${row.userId}`) ?? []);
      record(row.userId).hits.push({ problem, row, messages });
    }
  }

  for (const c of input.customer) {
    record(c.userId).customer.push(c);
  }

  for (const r of index.values()) {
    r.hits.sort((a, b) => b.row.firstErr - a.row.firstErr);
    // The latest day first: the verdict speaks of it.
    r.customer.sort((a, b) => b.lastMinute - a.lastMinute);
  }
  return index;
}

/** What a viewer table shows of a viewer: any row that knows them. */
export type ViewerFacts = ViewerDetail &
  Pick<AffectedUserRow, 'userId' | 'userKind' | 'platform' | 'network' | 'isp' | 'city' | 'topCode'>;

/** A day of errors on channels that worked for everyone else. */
export interface TheirSide {
  pid: string;
  provider: string;
  /** Channels with errors; 0 when only the message is left of it. */
  channels: number;
  minutes: number;
  until?: number;
}

/**
 * One line of the looked-up viewer: a problem they ran into, or errors only
 * on their side. Both carry the same facts (device, network, IP, error), so
 * support reads them in one table.
 */
export interface LookupRow {
  key: string;
  /** First error, or when the message went out if nothing else is left. */
  at: number;
  problem?: Problem;
  theirSide?: TheirSide;
  /** Undefined only for a message whose day of errors is no longer in the run. */
  facts?: ViewerFacts;
  errors?: number;
  messages: Decision[];
}

/** Problems and their-side days of one viewer, the latest first, each with what they were told. */
export function lookupRows(record: ViewerRecord): LookupRow[] {
  const rows: LookupRow[] = record.hits.map((h) => ({
    key: `p-${h.problem.id}`,
    at: h.row.firstErr,
    problem: h.problem,
    facts: h.row,
    errors: h.row.errEvents,
    messages: h.messages,
  }));
  const used = new Set<Decision>();
  for (const c of record.customer) {
    // The engine sends the diagnosis a minute after the last error of the day.
    const messages = record.diagnoses.filter(
      (d) => !used.has(d) && d.pid === c.pid && d.at >= c.firstMinute && d.at <= c.lastMinute + 60
    );
    messages.forEach((d) => used.add(d));
    rows.push({
      key: `c-${c.pid}-${c.firstMinute}`,
      at: c.firstMinute,
      theirSide: {
        pid: c.pid,
        provider: c.provider,
        channels: c.channels,
        minutes: c.minutes,
        until: c.lastMinute + 60,
      },
      facts: c,
      errors: c.errEvents,
      messages,
    });
  }
  for (const d of record.diagnoses) {
    if (!used.has(d)) {
      rows.push({
        key: `d-${d.pid}-${d.at}`,
        at: d.at,
        theirSide: { pid: d.pid, provider: d.provider, channels: 0, minutes: 0 },
        messages: [d],
      });
    }
  }
  return rows.sort((a, b) => b.at - a.at);
}

/** The channel titles of ViewerDetail.channelTitles. */
export function channelValues(value: string | undefined): string[] {
  return (value ?? '')
    .split(CHANNEL_SEP)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Channels of a wide problem by how many of its viewers had errors on them, most first. */
export function channelsOf(
  viewers: Array<Pick<ViewerDetail, 'channelTitles'>>
): Array<{ title: string; viewers: number }> {
  const counts = new Map<string, number>();
  for (const v of viewers) {
    for (const title of channelValues(v.channelTitles)) {
      counts.set(title, (counts.get(title) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([title, n]) => ({ title, viewers: n })).sort((a, b) => b.viewers - a.viewers);
}

export const MAX_VIEWER_MATCHES = 20;

/** The comma-separated values of a ViewerDetail field. */
export function detailValues(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Distinct values of one detail field over all rows of a viewer, in first-seen order. */
export function mergeDetail(rows: Array<ViewerDetail | undefined>, field: keyof ViewerDetail): string[] {
  return Array.from(new Set(rows.flatMap((r) => detailValues(r?.[field]))));
}

const ALIAS_FIELDS: Array<keyof ViewerDetail> = ['accounts', 'serials', 'deviceIds', 'ips'];

/**
 * Other ids of a viewer → their records: the raw account, device serials,
 * device ids and IP addresses seen on their errors. A caller may read any of
 * them off a device or a router instead of the account.
 */
export function buildViewerAliases(index: Map<string, ViewerRecord>): Map<string, ViewerRecord[]> {
  const aliases = new Map<string, ViewerRecord[]>();
  for (const [key, r] of index) {
    const rows: ViewerDetail[] = [...r.hits.map((h) => h.row), ...r.customer];
    for (const field of ALIAS_FIELDS) {
      for (const value of mergeDetail(rows, field)) {
        const alias = accountKey(value);
        if (alias === key) {
          continue;
        }
        const list = aliases.get(alias) ?? [];
        if (!list.includes(r)) {
          list.push(r);
        }
        aliases.set(alias, list);
      }
    }
  }
  return aliases;
}

/**
 * Viewers matching what support typed: the exact account if it is there, a
 * viewer whose IP, device serial or device id it is, otherwise every account
 * containing the text (at most MAX_VIEWER_MATCHES, plus the total).
 */
export function findViewers(
  index: Map<string, ViewerRecord>,
  query: string,
  aliases?: Map<string, ViewerRecord[]>
): { exact?: ViewerRecord; matches: ViewerRecord[]; total: number } {
  const key = accountKey(query);
  if (!key) {
    return { matches: [], total: 0 };
  }
  const exact = index.get(key);
  if (exact) {
    return { exact, matches: [exact], total: 1 };
  }
  const byAlias = aliases?.get(key);
  if (byAlias?.length) {
    return {
      exact: byAlias.length === 1 ? byAlias[0] : undefined,
      matches: byAlias.slice(0, MAX_VIEWER_MATCHES),
      total: byAlias.length,
    };
  }
  const matches: ViewerRecord[] = [];
  let total = 0;
  for (const [k, r] of index) {
    if (k.includes(key)) {
      total++;
      if (matches.length < MAX_VIEWER_MATCHES) {
        matches.push(r);
      }
    }
  }
  return { exact: total === 1 ? matches[0] : undefined, matches, total };
}

/** Median minutes from the start of a problem to its recovery, over the recovered ones. */
export function medianRecoveryMinutes(problems: Problem[]): number | undefined {
  const minutes = problems
    .filter((p) => p.recovered && p.closedAt !== undefined)
    .map((p) => (p.closedAt! - p.start) / 60)
    .sort((a, b) => a - b);
  if (!minutes.length) {
    return undefined;
  }
  const mid = Math.floor(minutes.length / 2);
  return minutes.length % 2 ? minutes[mid] : (minutes[mid - 1] + minutes[mid]) / 2;
}

/** Distinct viewers hit by any problem, and how many of them got a message. */
export function viewerTotals(index: Map<string, ViewerRecord>): { hit: number; told: number } {
  let hit = 0;
  let told = 0;
  for (const r of index.values()) {
    if (r.hits.length) {
      hit++;
      if (r.hits.some((h) => h.messages.some((m) => TOLD_KINDS.has(m.kind)))) {
        told++;
      }
    }
  }
  return { hit, told };
}
