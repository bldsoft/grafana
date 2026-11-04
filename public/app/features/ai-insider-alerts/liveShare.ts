// Analytix: shared Live of AI Insider Alerts. Every page that opens Live on
// the same datasource, providers and rules joins one "room" on the AI Insider
// service: the first one leads — it runs the detector through its own
// datasource as before and publishes its snapshot after every step — and the
// others follow, showing that snapshot without a query of their own. When the
// leader goes away, a follower takes over (the service hands it the lease)
// and starts the detector itself. Without the service (old version, not
// reachable) every page runs its own Live, as before.

import { authHeaders, getAssistantBaseUrl } from 'app/features/dashboard-scene/ai-panel/assistantClient';

import type { AlertsSnapshot } from './AlertsResults';
import type {
  ActivityIncident,
  AffectedUserRow,
  AlertSummary,
  ChannelReportRow,
  CorrelationGroup,
  CustomerSideRow,
  Decision,
  DeadChannel,
  Incident,
  IncidentClass,
  ProviderIncident,
} from './types';

/** Bumped when the shape changes: a page never shows a snapshot of another shape. */
export const SHARED_FORMAT = 1;
/** Followers ask for news this often; the leader renews its lease as often. */
export const SHARE_SYNC_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
const PUBLISH_TIMEOUT_MS = 60_000;
const CLIENT_KEY = 'analytix.aiAlerts.liveClient';

/** A snapshot as plain data: the functions of AlertsSnapshot become maps. */
export interface SharedSnapshot {
  v: number;
  summary: AlertSummary;
  incidents: Incident[];
  decisions: Decision[];
  customer: CustomerSideRow[];
  dead: DeadChannel[];
  channels: ChannelReportRow[];
  providers: ProviderIncident[];
  activity: ActivityIncident[];
  groups: CorrelationGroup[];
  blips: number;
  classes: Record<string, IncidentClass>;
  affected: Record<string, AffectedUserRow[]>;
  providerAffected: Record<string, AffectedUserRow[]>;
  from: number;
  to: number;
}

export function serializeSnapshot(s: AlertsSnapshot): SharedSnapshot {
  const classes: Record<string, IncidentClass> = {};
  const affected: Record<string, AffectedUserRow[]> = {};
  for (const inc of s.incidents) {
    classes[inc.id] = s.classOf(inc);
    const rows = s.affected(inc.id);
    if (rows.length) {
      affected[inc.id] = rows;
    }
  }
  const providerAffected: Record<string, AffectedUserRow[]> = {};
  for (const p of s.providers) {
    const rows = s.providerAffected(p.id);
    if (rows.length) {
      providerAffected[p.id] = rows;
    }
  }
  return {
    v: SHARED_FORMAT,
    summary: s.summary,
    incidents: s.incidents,
    decisions: s.decisions,
    customer: s.customer,
    dead: s.dead,
    channels: s.channels,
    providers: s.providers,
    activity: s.activity,
    groups: s.groups,
    blips: s.blips,
    classes,
    affected,
    providerAffected,
    from: s.from,
    to: s.to,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ARRAY_FIELDS = ['incidents', 'decisions', 'customer', 'dead', 'channels', 'providers', 'activity', 'groups'];
const MAP_FIELDS = ['classes', 'affected', 'providerAffected'];

function isSharedSnapshot(data: unknown): data is SharedSnapshot {
  return (
    isRecord(data) &&
    data.v === SHARED_FORMAT &&
    typeof data.from === 'number' &&
    typeof data.to === 'number' &&
    typeof data.blips === 'number' &&
    isRecord(data.summary) &&
    ARRAY_FIELDS.every((k) => Array.isArray(data[k])) &&
    MAP_FIELDS.every((k) => isRecord(data[k]))
  );
}

/** undefined for anything that is not a snapshot of this format. */
export function deserializeSnapshot(data: unknown): AlertsSnapshot | undefined {
  if (!isSharedSnapshot(data)) {
    return undefined;
  }
  const { classes, affected, providerAffected } = data;
  return {
    summary: data.summary,
    incidents: data.incidents,
    decisions: data.decisions,
    customer: data.customer,
    dead: data.dead,
    channels: data.channels,
    providers: data.providers,
    activity: data.activity,
    groups: data.groups,
    blips: data.blips,
    classOf: (inc) => classes[inc.id] ?? 'pending',
    affected: (id) => affected[id] ?? [],
    providerAffected: (id) => providerAffected[id] ?? [],
    from: data.from,
    to: data.to,
  };
}

/** What makes two Live runs the same: one room on the service. */
export interface LiveRoom {
  datasourceUid: string;
  /** Sorted; null = every provider (an org scoped to "*"). */
  pids: string[] | null;
  rulesHash: string;
}

/** FNV-1a of the rules in a fixed key order, as hex. */
export function rulesHash(rules: object): string {
  const text = JSON.stringify(Object.entries(rules).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function liveRoom(datasourceUid: string, pids: string[] | null, rules: object): LiveRoom {
  return {
    datasourceUid,
    pids: pids === null ? null : Array.from(new Set(pids)).sort(),
    rulesHash: rulesHash(rules),
  };
}

/** This page's id in the rooms; one per browser tab session. */
export function liveClientId(): string {
  try {
    const saved = sessionStorage.getItem(CLIENT_KEY);
    if (saved && /^[A-Za-z0-9_-]{8,64}$/.test(saved)) {
      return saved;
    }
    const id = `c-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
    sessionStorage.setItem(CLIENT_KEY, id);
    return id;
  } catch {
    return `c-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
  }
}

export interface SyncResult {
  role: 'leader' | 'follower';
  /** Snapshots published in the room so far. */
  version: number;
  /** End of the newest snapshot (epoch seconds), null before the first. */
  at: number | null;
  /** Pages in the room within the last two minutes, this one included. */
  watchers: number;
}

/** Thrown when the service cannot share Live: the page runs its own. */
export class ShareUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareUnavailableError';
  }
}

/** `signal`, or the timeout, whichever aborts first. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const abort = () => {
    clearTimeout(timer);
    controller.abort();
  };
  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

function url(action: string, query = ''): string {
  return `${getAssistantBaseUrl()}/api/alerts/live/${action}${query}`;
}

async function post(action: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(url(action), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
    signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
  });
}

export async function syncLive(room: LiveRoom, clientId: string, signal?: AbortSignal): Promise<SyncResult> {
  let res: Response;
  try {
    res = await post('sync', { room, clientId }, signal);
  } catch (e) {
    if (signal?.aborted) {
      throw e;
    }
    throw new ShareUnavailableError('The AI Insider service is not reachable');
  }
  const payload: unknown = await res.json().catch(() => null);
  const p = isRecord(payload) ? payload : {};
  if (!res.ok || p.status !== 'on' || (p.role !== 'leader' && p.role !== 'follower')) {
    throw new ShareUnavailableError(
      typeof p.reason === 'string' ? p.reason : `Shared Live is not available (HTTP ${res.status})`
    );
  }
  return {
    role: p.role,
    version: typeof p.version === 'number' ? p.version : 0,
    at: typeof p.at === 'number' ? p.at : null,
    watchers: typeof p.watchers === 'number' ? p.watchers : 1,
  };
}

/** The newest snapshot of the room; undefined before the first, or of another format. */
export async function fetchSharedSnapshot(
  room: LiveRoom,
  clientId: string,
  signal?: AbortSignal
): Promise<AlertsSnapshot | undefined> {
  const res = await post('snapshot', { room, clientId }, signal);
  if (res.status === 204 || !res.ok) {
    return undefined;
  }
  return deserializeSnapshot(await res.json().catch(() => null));
}

async function gzip(text: string): Promise<Blob | undefined> {
  if (typeof CompressionStream === 'undefined') {
    return undefined;
  }
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

/** The leader's snapshot after a step. false = this page no longer leads the room. */
export async function publishSnapshot(
  room: LiveRoom,
  clientId: string,
  snapshot: AlertsSnapshot,
  signal?: AbortSignal
): Promise<boolean> {
  const text = JSON.stringify(serializeSnapshot(snapshot));
  const packed = await gzip(text);
  const query = `?room=${encodeURIComponent(JSON.stringify({ room, clientId }))}`;
  const res = await fetch(url('publish', query), {
    method: 'POST',
    headers: { 'Content-Type': packed ? 'application/gzip' : 'application/json', ...authHeaders() },
    body: packed ?? text,
    signal: withTimeout(signal, PUBLISH_TIMEOUT_MS),
  });
  if (res.status === 409) {
    return false;
  }
  if (!res.ok) {
    throw new Error(`Publishing the shared Live failed (HTTP ${res.status})`);
  }
  return true;
}

/** A leader leaving hands the room over at once. Best effort, also on page unload. */
export function leaveLive(room: LiveRoom, clientId: string): void {
  try {
    void fetch(url('leave'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ room, clientId }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Leaving is a courtesy: the lease runs out on its own.
  }
}

/** Where this page stands in the shared Live. */
export interface ShareStatus {
  /** local: no sharing (the service is not there); leader: runs the detector for the room; follower: shows its snapshot. */
  mode: 'local' | 'leader' | 'follower';
  watchers: number;
  /** End of the newest shared snapshot. */
  at: number | null;
  /** The service did not answer the last time: the page keeps what it has and tries again. */
  issue?: string;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

export interface SharedLiveOptions {
  room: LiveRoom;
  clientId: string;
  signal: AbortSignal;
  /**
   * Runs the detector on this page until `signal` aborts, calling `publish`
   * with the snapshot after every step (a no-op when not sharing).
   */
  runOwn: (signal: AbortSignal, publish: (snapshot: AlertsSnapshot) => void) => Promise<void>;
  /** A newer snapshot of the room's leader. */
  onSnapshot: (snapshot: AlertsSnapshot) => void;
  onStatus: (status: ShareStatus) => void;
  /** Overrides for tests. */
  syncMs?: number;
  api?: {
    sync: typeof syncLive;
    fetch: typeof fetchSharedSnapshot;
    publish: typeof publishSnapshot;
    leave: typeof leaveLive;
  };
}

/**
 * Live through the room: leads (runs the detector and publishes) or follows
 * (shows the leader's snapshot), switching when the lease moves. Without the
 * service at the start the page simply runs its own Live.
 */
export async function runSharedLive(opts: SharedLiveOptions): Promise<void> {
  const { room, clientId, signal } = opts;
  const api = opts.api ?? { sync: syncLive, fetch: fetchSharedSnapshot, publish: publishSnapshot, leave: leaveLive };
  const syncMs = opts.syncMs ?? SHARE_SYNC_MS;
  let first = true;
  let seenVersion = 0;
  let last: ShareStatus = { mode: 'follower', watchers: 1, at: null };
  const status = (next: ShareStatus) => {
    last = next;
    opts.onStatus(next);
  };

  while (!signal.aborted) {
    let sync: SyncResult;
    try {
      sync = await api.sync(room, clientId, signal);
    } catch (e) {
      if (signal.aborted) {
        return;
      }
      if (first) {
        // No shared Live on this service: the page runs its own, as before.
        status({ mode: 'local', watchers: 1, at: null });
        await opts.runOwn(signal, () => undefined);
        return;
      }
      status({ ...last, issue: e instanceof Error ? e.message : String(e) });
      await sleep(syncMs, signal);
      continue;
    }
    first = false;

    if (sync.role === 'follower') {
      status({ mode: 'follower', watchers: sync.watchers, at: sync.at });
      if (sync.version > 0 && sync.version !== seenVersion) {
        try {
          const snapshot = await api.fetch(room, clientId, signal);
          if (snapshot) {
            seenVersion = sync.version;
            opts.onSnapshot(snapshot);
          }
        } catch (e) {
          if (signal.aborted) {
            return;
          }
          status({ ...last, issue: e instanceof Error ? e.message : String(e) });
        }
      }
      await sleep(syncMs, signal);
      continue;
    }

    // Leader: run the detector here, publish every step, keep the lease.
    status({ mode: 'leader', watchers: sync.watchers, at: sync.at });
    const own = new AbortController();
    const stopOwn = () => own.abort();
    signal.addEventListener('abort', stopOwn, { once: true });
    let lost = false;
    let pending: AlertsSnapshot | undefined;
    let busy = false;
    const flush = async () => {
      busy = true;
      while (pending && !own.signal.aborted) {
        const snapshot = pending;
        pending = undefined;
        try {
          if (!(await api.publish(room, clientId, snapshot, own.signal))) {
            lost = true;
            own.abort();
          }
        } catch (e) {
          if (!own.signal.aborted) {
            status({ ...last, issue: e instanceof Error ? e.message : String(e) });
          }
        }
      }
      busy = false;
    };
    // Only the newest snapshot matters: a slow publish never queues old ones.
    const publish = (snapshot: AlertsSnapshot) => {
      pending = snapshot;
      if (!busy) {
        void flush();
      }
    };
    const heartbeat = setInterval(async () => {
      try {
        const beat = await api.sync(room, clientId, own.signal);
        if (beat.role !== 'leader') {
          lost = true;
          own.abort();
          return;
        }
        status({ mode: 'leader', watchers: beat.watchers, at: beat.at });
      } catch (e) {
        if (!own.signal.aborted) {
          status({ ...last, issue: e instanceof Error ? e.message : String(e) });
        }
      }
    }, syncMs);
    try {
      await opts.runOwn(own.signal, publish);
    } finally {
      clearInterval(heartbeat);
      signal.removeEventListener('abort', stopOwn);
    }
    if (signal.aborted) {
      api.leave(room, clientId);
      return;
    }
    if (!lost) {
      return;
    }
    // Another page leads now: follow it from its next snapshot.
    seenVersion = 0;
  }
}
