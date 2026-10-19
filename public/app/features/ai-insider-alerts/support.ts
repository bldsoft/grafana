// The support view of a run: every confirmed problem (channel, provider-wide,
// app level) in one list, and a per-account index for "a viewer is on the
// phone, what happened to them". Pure functions over the engine snapshot.

import { accountKey } from './push/pushPlan';
import type {
  ActivityIncident,
  AffectedUserRow,
  CustomerSideRow,
  Decision,
  Incident,
  IncidentClass,
  ProviderIncident,
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

/** Ongoing first (chronic channels last among them), then the most recent. */
function rank(p: Problem): number {
  return p.ongoing ? (p.kind === 'chronic' ? 1 : 0) : 2;
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
  }
  return index;
}

export const MAX_VIEWER_MATCHES = 20;

/**
 * Accounts matching what support typed: the exact account if it is there,
 * otherwise every account containing the text (at most MAX_VIEWER_MATCHES,
 * plus the total).
 */
export function findViewers(
  index: Map<string, ViewerRecord>,
  query: string
): { exact?: ViewerRecord; matches: ViewerRecord[]; total: number } {
  const key = accountKey(query);
  if (!key) {
    return { matches: [], total: 0 };
  }
  const exact = index.get(key);
  if (exact) {
    return { exact, matches: [exact], total: 1 };
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
