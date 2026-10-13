// Analytix: client for the ai-grafana-helper backend (SSE over POST).
// The backend lives in a separate private repository; it validates the SQL
// server-side and returns a ready GeneratedPanelSpec.

import { DataSourceRef, store } from '@grafana/data';
import { config } from '@grafana/runtime';
import type { BehaviorResult, BehaviorRow, BehaviorStatusCode } from 'app/features/ai-insider-alerts/keep/types';

import { isSafeBridgeSql, runRawQuery } from './datasourceQuery';
import { GeneratedPanelSpec, StaticFieldType, StaticPanelData, SUPPORTED_PANEL_TYPES } from './types';

// Silence watchdog: the backend sends a padded SSE heartbeat every 15s, so no
// bytes at all for this long means the connection died silently (dropped
// tunnel, laptop sleep, NAT timeout) — surface an error instead of spinning
// forever. Generous on purpose: a false positive aborts a paid generation
// mid-flight (2026-08-21 three identical remote-user runs died at the old 40s
// limit behind a chunk-buffering proxy and were retried from scratch at full
// cost), while a true positive only delays the error message a bit.
const SSE_IDLE_TIMEOUT_MS = 90000;

// A Grafana time expression the inline scene's SceneTimeRange understands:
// `now`, `now-30d`, `now-1h/h`, `now/d`, an ISO date, or epoch millis. Anything
// else from a version-skewed (or hostile) backend is dropped to the defaults.
const GRAFANA_TIME_RE = /^(now([-+]\d+[smhdwMy]+)?(\/[smhdwMy]+)?|\d{4}-\d{2}-\d{2}[^\s]*|\d+)$/;

function sanitizeTime(value: unknown): string | undefined {
  return typeof value === 'string' && GRAFANA_TIME_RE.test(value.trim()) ? value.trim() : undefined;
}

/** Live progress from the agent while it explores the schema and writes SQL. */
export interface AssistantProgress {
  text: string;
  tool: string | null;
  toolCounts: Record<string, number>;
}

/** Terminal payload: either a panel spec, or a plain-text assistant message. */
export interface AssistantResult {
  spec: GeneratedPanelSpec | null;
  message: string;
  sessionId: string | null;
  durationMs?: number;
  costUsd?: number | null;
}

/**
 * A failed generation still carries the backend session id: the agent's
 * discoveries survive the failure (e.g. a timeout), so retrying with this id
 * resumes from where it stopped instead of starting over.
 */
export class AssistantError extends Error {
  sessionId: string | null;

  constructor(message: string, sessionId: string | null = null) {
    super(message);
    this.name = 'AssistantError';
    this.sessionId = sessionId;
  }
}

// Production builds default to a same-origin path: the service is deployed
// behind the same reverse proxy as Grafana (route `/ai-insider` — see
// DEPLOY.md in the analytix-ai-insider repo), so the browser sends the
// grafana_session cookie with every request and the backend validates it
// against the Grafana API. No localStorage setup is needed in prod. Dev
// builds keep the local service default; the localStorage override wins in
// both cases (dev/debug only).
const DEFAULT_URL = config.buildInfo.env === 'development' ? 'http://localhost:8765' : '/ai-insider';
const URL_OVERRIDE_KEY = 'analytix.aiAssistantUrl';
const TOKEN_KEY = 'analytix.aiAssistantToken';

export function getAssistantBaseUrl(): string {
  try {
    const override = store.get(URL_OVERRIDE_KEY);
    // Accept only a plain http(s) base — a corrupted/hostile override with any
    // other scheme (javascript:, data:, ...) falls back to the default instead
    // of ending up in fetch() URLs. Trailing slashes are trimmed because the
    // callers append `/api/...` themselves.
    if (typeof override === 'string' && /^https?:\/\//i.test(override.trim())) {
      return override.trim().replace(/\/+$/, '');
    }
  } catch {}
  return DEFAULT_URL;
}

/** Auth headers for a non-localhost backend (see AUTH_TOKEN on the service). */
function authHeaders(): Record<string, string> {
  // The extra header also skips the ngrok free-tier browser interstitial,
  // which would otherwise replace API responses with an HTML warning page.
  const headers: Record<string, string> = { 'ngrok-skip-browser-warning': '1' };
  try {
    const token = store.get(TOKEN_KEY);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  } catch {}
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function checkAssistantHealth(): Promise<{ ok: boolean }> {
  try {
    const res = await fetch(`${getAssistantBaseUrl()}/healthz`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      return { ok: false };
    }
    const body = await res.json();
    return { ok: Boolean(body.ok) };
  } catch {
    return { ok: false };
  }
}

/** One data domain of the user's organization, as the chat's "Data" menu shows it. */
export interface DataDomain {
  id: 'streaming' | 'behavior' | 'finance';
  /** on = can be asked about; off = not connected for the org; misconfigured =
   *  assigned but unreachable right now; unavailable = not offered to anyone yet. */
  status: 'on' | 'off' | 'misconfigured' | 'unavailable';
  /** GA4 properties behind the behavior domain (display names). */
  properties: Array<{ id: string; name: string }>;
}

const DOMAIN_IDS: Array<DataDomain['id']> = ['streaming', 'behavior', 'finance'];
const DOMAIN_STATUSES: Array<DataDomain['status']> = ['on', 'off', 'misconfigured', 'unavailable'];

/**
 * The data domains of the current user's organization (GET /api/capabilities).
 * Best-effort: null when the service is older than the endpoint or
 * unreachable — the chat then shows streaming only, as before.
 */
export async function fetchCapabilities(): Promise<DataDomain[] | null> {
  try {
    const res = await fetch(`${getAssistantBaseUrl()}/api/capabilities`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return null;
    }
    const body = await res.json();
    if (!isRecord(body) || !Array.isArray(body.domains)) {
      return null;
    }
    const domains: DataDomain[] = [];
    for (const item of body.domains) {
      const id = isRecord(item) ? DOMAIN_IDS.find((candidate) => candidate === item.id) : undefined;
      const status = isRecord(item) ? DOMAIN_STATUSES.find((candidate) => candidate === item.status) : undefined;
      if (!isRecord(item) || !id || !status) {
        continue;
      }
      const properties = Array.isArray(item.properties)
        ? item.properties
            .filter(
              (p): p is Record<string, unknown> => isRecord(p) && typeof p.id === 'string' && typeof p.name === 'string'
            )
            .slice(0, 20)
            .map((p) => ({ id: String(p.id).slice(0, 40), name: String(p.name).slice(0, 100) }))
        : [];
      domains.push({ id, status, properties });
    }
    return domains;
  } catch {
    return null;
  }
}

/** Request of POST /api/keep/behavior: GA4 evidence of these accounts for the recent window. */
export interface KeepBehaviorRequest {
  /** As-of day, YYYY-MM-DD. */
  asOf: string;
  recentDays: number;
  /** Normalized account keys (upper case, no '-') per provider id. */
  accountsByPid: Record<string, string[]>;
}

// The backend may have to read missing GA4 days before it answers; a slower
// answer is abandoned here while the backend keeps filling its own cache.
const KEEP_BEHAVIOR_TIMEOUT_MS = 150000;
// Accounts per request (the backend accepts at most 5000).
const KEEP_BEHAVIOR_BATCH = 2000;
const KEEP_ACCOUNT_RE = /^[A-Z0-9]{4,24}$/;
const KEEP_PID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const KEEP_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const BEHAVIOR_STATUSES: BehaviorStatusCode[] = ['on', 'partial', 'pending', 'off', 'budget', 'error', 'unavailable'];
const BEHAVIOR_PLATFORMS = ['android', 'android_tv', 'ios', 'tvos', 'smarttv', 'other'];
const MALFORMED_BEHAVIOR = 'Malformed GA4 evidence response.';
// The backend answers with fixed reason codes; only these become text, so a
// version-skewed (or hostile) backend cannot put its own words on the page.
const BEHAVIOR_REASONS: Record<string, string> = {
  rate_limit: 'Too many GA4 requests; try again in a minute.',
  daily_budget: 'The daily GA4 query budget is used up.',
  too_large: 'A GA4 day is too large to read.',
  timeout: 'GA4 did not answer in time.',
  quota: 'The GA4 query quota is exhausted for now.',
  bigquery: 'GA4 could not be read.',
  in_progress: 'GA4 days are still being read; run again in a few minutes.',
  export_pending: 'The GA4 export has no complete day yet.',
  no_complete_days: 'No complete GA4 day in this window yet.',
  missing_days: 'Some GA4 days of the window are missing.',
  no_binding: 'GA4 is not linked to these providers.',
  no_export: 'The GA4 export is not available.',
  no_access: 'The GA4 export is not readable.',
  behavior_off: 'GA4 is not connected for this organization.',
};

const normalizeAccountKey = (account: string) => account.trim().toUpperCase().replace(/_.*$/, '').replace(/-/g, '');

/** A non-negative whole number from a backend value (strings included), 0 otherwise. */
function countOf(value: unknown, max = 1e9): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.floor(n)) : 0;
}

/** countOf for a field the backend may leave out: undefined when it is not a number. */
function optionalCount(value: unknown, max = 1e9): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? countOf(n, max) : undefined;
}

function behaviorRow(value: unknown): BehaviorRow | null {
  if (!isRecord(value)) {
    return null;
  }
  const { pid, account } = value;
  if (
    typeof pid !== 'string' ||
    !KEEP_PID_RE.test(pid) ||
    typeof account !== 'string' ||
    !KEEP_ACCOUNT_RE.test(account)
  ) {
    return null;
  }
  const minutes = Number(value.engagementMin);
  const days = countOf(value.days, 28);
  const platforms: unknown[] = Array.isArray(value.platforms) ? value.platforms : [];
  return {
    pid,
    account,
    days,
    sessions: countOf(value.sessions),
    engagementMin: Number.isFinite(minutes) && minutes > 0 ? Math.min(1e9, Math.round(minutes * 10) / 10) : 0,
    searchSessions: countOf(value.searchSessions),
    searchNoPlaySessions: countOf(value.searchNoPlaySessions),
    browseNoPlaySessions: countOf(value.browseNoPlaySessions),
    crashes: countOf(value.crashes),
    crashDays: Math.min(days, countOf(value.crashDays, 28)),
    errorScreenSessions: countOf(value.errorScreenSessions),
    noInternetSessions: countOf(value.noInternetSessions),
    accountVisits: countOf(value.accountVisits),
    logoutClicks: countOf(value.logoutClicks),
    myListAdds: countOf(value.myListAdds),
    myListRemoves: countOf(value.myListRemoves),
    platforms: BEHAVIOR_PLATFORMS.filter((platform) => platforms.includes(platform)),
  };
}

/**
 * A POST /api/keep/behavior answer as the Keep engine may use it: the status
 * from the fixed set (anything else is 'error'), a well-formed window, rows
 * only for data statuses and only for accounts that were asked about
 * (`sent`, pid -> accounts), numbers coerced and clamped. The counts are the
 * backend's (`requested` = accounts of providers with GA4 bound, `notLinked` =
 * accounts of providers without), capped by what was sent; an answer without
 * them counts every sent account as requested. Exported for tests.
 */
export function normalizeBehaviorResult(payload: unknown, sent?: Map<string, Set<string>>): BehaviorResult {
  if (!isRecord(payload)) {
    return { status: 'error', rows: [], message: MALFORMED_BEHAVIOR };
  }
  const status = BEHAVIOR_STATUSES.find((candidate) => candidate === payload.status) ?? 'error';
  const rows: BehaviorRow[] = [];
  if ((status === 'on' || status === 'partial') && Array.isArray(payload.rows)) {
    const seen = new Set<string>();
    for (const item of payload.rows) {
      const row = behaviorRow(item);
      const key = row ? `${row.pid}|${row.account}` : '';
      if (row && !seen.has(key) && (!sent || sent.get(row.pid)?.has(row.account))) {
        seen.add(key);
        rows.push(row);
      }
    }
  }
  const window = isRecord(payload.window) ? payload.window : null;
  const sentCount = sent ? [...sent.values()].reduce((n, accounts) => n + accounts.size, 0) : undefined;
  const message = typeof payload.reason === 'string' ? BEHAVIOR_REASONS[payload.reason] : undefined;
  const backendRequested = optionalCount(payload.requested, sentCount);
  const requested = backendRequested ?? sentCount ?? 0;
  const notLinked = optionalCount(payload.notLinked, sentCount === undefined ? undefined : sentCount - requested);
  const backendMatched = optionalCount(payload.matched);
  return {
    status,
    ...(window &&
    typeof window.from === 'string' &&
    KEEP_DAY_RE.test(window.from) &&
    typeof window.to === 'string' &&
    KEEP_DAY_RE.test(window.to)
      ? { window: { from: window.from, to: window.to, days: countOf(window.days, 28) } }
      : {}),
    // Only rows that survived the checks above count as matched.
    matched: Math.min(rows.length, backendMatched ?? rows.length),
    requested,
    ...(notLinked !== undefined ? { notLinked } : {}),
    ...(message ? { message } : {}),
    rows,
  };
}

/** The caller's signal plus our own timeout; `timedOut` tells the two apart. */
function withTimeout(signal: AbortSignal | undefined, ms: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  const onAbort = () => controller.abort();
  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function postKeepBehavior(
  request: KeepBehaviorRequest,
  sent: Map<string, Set<string>>,
  signal?: AbortSignal
): Promise<BehaviorResult> {
  const requested = [...sent.values()].reduce((n, accounts) => n + accounts.size, 0);
  const failed = (status: BehaviorStatusCode, message?: string): BehaviorResult => ({
    status,
    rows: [],
    matched: 0,
    requested,
    ...(message ? { message } : {}),
  });
  const timeout = withTimeout(signal, KEEP_BEHAVIOR_TIMEOUT_MS);
  try {
    const res = await fetch(`${getAssistantBaseUrl()}/api/keep/behavior`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(request),
      signal: timeout.signal,
    });
    // Not allowed for this user or org, or a backend older than the route.
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return failed('unavailable');
    }
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      if (signal?.aborted || timeout.timedOut()) {
        throw new Error('aborted');
      }
    }
    if (!res.ok) {
      const reason =
        isRecord(payload) && typeof payload.reason === 'string' ? BEHAVIOR_REASONS[payload.reason] : undefined;
      return failed('error', reason ?? `GA4 evidence request failed (HTTP ${res.status}).`);
    }
    return normalizeBehaviorResult(payload, sent);
  } catch (e) {
    if (signal?.aborted) {
      throw e;
    }
    return failed(
      'error',
      timeout.timedOut() ? 'GA4 evidence did not arrive in time.' : 'The AI Insider service is unreachable.'
    );
  } finally {
    timeout.cleanup();
  }
}

/**
 * GA4 evidence of these accounts for the recent window (POST
 * /api/keep/behavior, same base URL and auth as the chat). Accounts are
 * normalized and checked here, sent in batches of 2000, and the answers merged:
 * rows joined, the backend's counts (`requested`, `matched`, `notLinked`)
 * summed; a batch that fails makes the whole result that failure. Never
 * throws, except when the caller's signal aborts.
 */
export async function fetchKeepBehavior(request: KeepBehaviorRequest, signal?: AbortSignal): Promise<BehaviorResult> {
  const accounts: Array<[string, string]> = [];
  for (const [pid, list] of Object.entries(request.accountsByPid ?? {})) {
    if (!KEEP_PID_RE.test(pid) || !Array.isArray(list)) {
      continue;
    }
    const keys = new Set(
      list
        .filter((a): a is string => typeof a === 'string')
        .map(normalizeAccountKey)
        .filter((a) => KEEP_ACCOUNT_RE.test(a))
    );
    keys.forEach((account) => accounts.push([pid, account]));
  }
  const parts: BehaviorResult[] = [];
  // Accounts of providers without GA4 bound, as the backend counted them (undefined: it did not say).
  let notLinked: number | undefined;
  // One request even without accounts: the status still tells the page whether GA4 evidence exists.
  for (let start = 0; start === 0 || start < accounts.length; start += KEEP_BEHAVIOR_BATCH) {
    const sent = new Map<string, Set<string>>();
    for (const [pid, account] of accounts.slice(start, start + KEEP_BEHAVIOR_BATCH)) {
      sent.set(pid, (sent.get(pid) ?? new Set<string>()).add(account));
    }
    const accountsByPid = Object.fromEntries([...sent].map(([pid, set]) => [pid, [...set]]));
    const part = await postKeepBehavior(
      { asOf: request.asOf, recentDays: request.recentDays, accountsByPid },
      sent,
      signal
    );
    if (part.notLinked !== undefined) {
      notLinked = (notLinked ?? 0) + part.notLinked;
    }
    if (part.status !== 'on' && part.status !== 'partial') {
      // The batches not sent are unknown: they count as requested.
      return {
        ...part,
        rows: [],
        matched: 0,
        requested: accounts.length - (notLinked ?? 0),
        ...(notLinked !== undefined ? { notLinked } : {}),
      };
    }
    parts.push(part);
  }
  const rows = parts.flatMap((part) => part.rows);
  const window = parts.find((part) => part.window)?.window;
  const message = parts.find((part) => part.message)?.message;
  return {
    status: parts.some((part) => part.status === 'partial') ? 'partial' : 'on',
    ...(window ? { window } : {}),
    ...(message ? { message } : {}),
    matched: parts.reduce((n, part) => n + (part.matched ?? part.rows.length), 0),
    requested: parts.reduce((n, part) => n + (part.requested ?? 0), 0),
    ...(notLinked !== undefined ? { notLinked } : {}),
    rows,
  };
}

/** One test push: an FCM registration token of an account and the text it gets. */
export interface TestPushMessage {
  pid: string;
  account: string;
  token: string;
  title: string;
  text: string;
  /** true = show the service-status warning with the text; false = clear it. */
  enabled: boolean;
  kind?: string;
}

export interface TestPushResult {
  /** on = sent (or checked); off = the service has no push key; error = refused or unreachable. */
  status: 'on' | 'off' | 'error';
  message?: string;
  /** Per message, in request order (status on only). */
  results: Array<{ ok: boolean; error?: string }>;
}

const TEST_PUSH_BATCH = 200;
const TEST_PUSH_TIMEOUT_MS = 60_000;
const TEST_PUSH_REASONS: Record<string, string> = {
  no_providers: 'Your organization has no providers assigned.',
  no_scope: 'The service has no data scope for this request (no organization).',
  provider_out_of_scope: 'A message targets a provider outside your organization.',
  rate_limited: 'Hourly limit of test pushes reached.',
  bad_message: 'A message has an invalid token, account or text.',
  too_many_messages: 'Too many messages in one request.',
  // Client-side outcomes, not backend reasons.
  old_service: 'The AI Insider service is older than test pushes.',
  unreachable: 'The AI Insider service is unreachable.',
};

/**
 * Send test pushes through the AI Insider service (POST /api/notify/push),
 * which holds the Firebase key. validateOnly asks FCM to check the tokens
 * without delivering anything.
 */
export async function sendTestPush(messages: TestPushMessage[], validateOnly: boolean): Promise<TestPushResult> {
  const results: TestPushResult['results'] = [];
  for (let start = 0; start < messages.length; start += TEST_PUSH_BATCH) {
    const batch = messages.slice(start, start + TEST_PUSH_BATCH);
    try {
      const res = await fetch(`${getAssistantBaseUrl()}/api/notify/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ messages: batch, validateOnly }),
        signal: AbortSignal.timeout(TEST_PUSH_TIMEOUT_MS),
      });
      const payload: unknown = await res.json().catch(() => null);
      if (res.status === 404) {
        return { status: 'error', message: TEST_PUSH_REASONS.old_service, results };
      }
      if (isRecord(payload) && payload.status === 'off') {
        return { status: 'off', results };
      }
      if (!res.ok || !isRecord(payload) || !Array.isArray(payload.results)) {
        const reason =
          isRecord(payload) && typeof payload.reason === 'string' ? TEST_PUSH_REASONS[payload.reason] : undefined;
        return { status: 'error', message: reason ?? `Push request failed (HTTP ${res.status}).`, results };
      }
      for (let i = 0; i < batch.length; i++) {
        const r: unknown = payload.results[i];
        const ok = isRecord(r) && r.ok === true;
        const error = isRecord(r) && typeof r.error === 'string' ? r.error.slice(0, 40) : 'error';
        results.push(ok ? { ok } : { ok, error });
      }
    } catch {
      return { status: 'error', message: TEST_PUSH_REASONS.unreachable, results };
    }
  }
  return { status: 'on', results };
}

/** Suggestion chip for the chat empty state: a past prompt plus what it produced. */
export interface SuggestedPrompt {
  prompt: string;
  /** Panel type of the generated chart, or 'summary' for a text answer. */
  kind: string;
}

// Hard caps on strings coming back from the service: the base URL can be
// overridden via localStorage, so a hostile backend must not be able to
// inflate the DOM (or the input box) with megabyte-long "prompts".
const MAX_SUGGESTIONS = 5;
const MAX_SUGGESTION_PROMPT_CHARS = 300;
const MAX_SUGGESTION_KIND_CHARS = 40;

/**
 * Recent successful prompts of the current Grafana user, newest first.
 * POST keeps the login out of URLs (tunnel/proxy access logs). Best-effort:
 * any failure (service down, no user, bad shape) resolves to an empty list
 * and the chat falls back to the built-in default suggestions.
 */
export async function fetchSuggestions(): Promise<SuggestedPrompt[]> {
  const user = config.bootData?.user?.login;
  if (!user) {
    return [];
  }
  try {
    const res = await fetch(`${getAssistantBaseUrl()}/api/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ user }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      return [];
    }
    const body = await res.json();
    if (!isRecord(body) || !Array.isArray(body.suggestions)) {
      return [];
    }
    const suggestions: SuggestedPrompt[] = [];
    for (const item of body.suggestions.slice(0, MAX_SUGGESTIONS)) {
      if (isRecord(item) && typeof item.prompt === 'string' && item.prompt.trim() !== '') {
        suggestions.push({
          prompt: item.prompt.trim().slice(0, MAX_SUGGESTION_PROMPT_CHARS),
          kind: typeof item.kind === 'string' && item.kind ? item.kind.slice(0, MAX_SUGGESTION_KIND_CHARS) : 'summary',
        });
      }
    }
    return suggestions;
  } catch {
    return [];
  }
}

/**
 * Wipe the current user's server-side prompt history and personalized
 * suggestion chips, so the chat empty state falls back to the cold-start
 * defaults. Resolves false when the service refused or is unreachable.
 */
export async function resetAssistantHistory(): Promise<boolean> {
  const user = config.bootData?.user?.login;
  if (!user) {
    return false;
  }
  try {
    const res = await fetch(`${getAssistantBaseUrl()}/api/history-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ user }),
      signal: AbortSignal.timeout(6000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

interface GenerateArgs {
  prompt: string;
  /** ClickHouse datasource that executes the agent's exploration queries (and later the panel). */
  datasource: DataSourceRef;
  sessionId?: string | null;
  signal?: AbortSignal;
  onProgress?: (progress: AssistantProgress) => void;
  /**
   * Fired as soon as the backend announces the full-agent session id — long
   * before the terminal event. Storing it lets a Stop press keep the resume
   * context instead of losing everything the agent had discovered.
   */
  onSession?: (sessionId: string) => void;
}

/**
 * Browser leg of the query bridge: execute the SQL from a `query` SSE event
 * through the user's datasource and POST the result back to the backend.
 * Errors are shipped back too — the agent reads them and self-corrects.
 */
async function answerQueryEvent(
  datasource: DataSourceRef,
  payload: Record<string, unknown>,
  signal?: AbortSignal
): Promise<void> {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
  const sql = typeof payload.sql === 'string' ? payload.sql : '';
  const maxRows = typeof payload.maxRows === 'number' && payload.maxRows > 0 ? payload.maxRows : 200;
  if (!requestId) {
    return;
  }

  let body: Record<string, unknown>;
  try {
    if (!sql) {
      throw new Error('empty SQL statement');
    }
    // The generation's abort signal cancels the datasource HTTP call too, so a
    // Stop press does not leave a heavy ClickHouse query running to completion.
    const result = await runRawQuery(datasource, sql, maxRows, signal);
    body = { requestId, ok: true, data: result.data, rows: result.rows, meta: result.meta };
  } catch (e) {
    body = { requestId, ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  try {
    await fetch(`${getAssistantBaseUrl()}/api/query-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
  } catch {
    // Nothing to do: the backend times the request out and tells the agent.
  }
}

/**
 * POST /api/generate and consume the SSE stream. Resolves with the terminal
 * `result` event; rejects on `error` events, HTTP errors or malformed specs.
 */
export async function generatePanel({
  prompt,
  datasource,
  sessionId,
  signal,
  onProgress,
  onSession,
}: GenerateArgs): Promise<AssistantResult> {
  const res = await fetch(`${getAssistantBaseUrl()}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    // `user` attributes the request in the backend audit log; access control
    // stays on the bearer token.
    body: JSON.stringify({
      prompt,
      sessionId: sessionId || undefined,
      user: config.bootData?.user?.login || undefined,
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    let detail = `${res.status}`;
    try {
      const body = await res.json();
      detail = body.error || detail;
    } catch {}
    throw new Error(`Assistant service error: ${detail}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: AssistantResult | null = null;

  const handleEvent = (event: string, dataLine: string) => {
    let payload: unknown;
    try {
      payload = JSON.parse(dataLine);
    } catch {
      return;
    }
    if (event === 'progress' && onProgress && isRecord(payload)) {
      const toolCounts: Record<string, number> = {};
      if (isRecord(payload.toolCounts)) {
        for (const [tool, count] of Object.entries(payload.toolCounts)) {
          if (typeof count === 'number') {
            toolCounts[tool] = count;
          }
        }
      }
      onProgress({
        text: typeof payload.text === 'string' ? payload.text : '',
        tool: typeof payload.tool === 'string' ? payload.tool : null,
        toolCounts,
      });
    } else if (event === 'query' && isRecord(payload)) {
      // Fire-and-forget: the SSE reader must keep draining while the
      // datasource executes; the backend blocks on its own promise.
      void answerQueryEvent(datasource, payload, signal);
    } else if (event === 'session' && isRecord(payload)) {
      if (onSession && typeof payload.sessionId === 'string' && payload.sessionId) {
        onSession(payload.sessionId);
      }
    } else if (event === 'result') {
      result = normalizeResult(payload);
    } else if (event === 'error') {
      const body: Record<string, unknown> = isRecord(payload) ? payload : {};
      throw new AssistantError(
        typeof body.message === 'string' ? body.message : 'unknown error',
        typeof body.sessionId === 'string' ? body.sessionId : null
      );
    }
  };

  // Minimal SSE parser: events are separated by a blank line; we only emit
  // single-line JSON payloads, so one `data:` line per event is guaranteed.
  const processChunk = (chunk: string) => {
    // Normalize CRLF so a proxy that rewrites line endings does not break the
    // blank-line (`\n\n`) event separator search below.
    buffer = (buffer + chunk).replace(/\r\n/g, '\n');
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = 'message';
      let data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data = line.slice(5).trim();
        }
      }
      if (data) {
        handleEvent(event, data);
      }
    }
  };

  try {
    while (true) {
      // Race each read against an idle watchdog: heartbeats keep it fed, so a
      // timeout means the stream went silent and we should fail instead of hang.
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        idleTimer = setTimeout(
          () => reject(new Error('The assistant stopped responding. Check your connection and try again.')),
          SSE_IDLE_TIMEOUT_MS
        );
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), idle]);
      } finally {
        clearTimeout(idleTimer);
      }
      if (chunk.done) {
        break;
      }
      processChunk(decoder.decode(chunk.value, { stream: true }));
    }
  } finally {
    // Release the connection if we bail out mid-stream (error event or the idle
    // watchdog firing).
    try {
      await reader.cancel();
    } catch {}
  }

  if (!result) {
    throw new Error('The assistant stream ended without a result.');
  }
  return result;
}

// Caps on a GA4 result frame: it is rendered as-is, so a version-skewed or
// hostile backend must not be able to push an unbounded table into the DOM.
const MAX_STATIC_FIELDS = 20;
const MAX_STATIC_ROWS = 5000;
const MAX_STATIC_CELL_CHARS = 1024;
const STATIC_FIELD_TYPES: StaticFieldType[] = ['time', 'number', 'string'];

/** Exported for tests: validate a GA4 result frame, or null when malformed. */
export function normalizeStaticData(raw: unknown): StaticPanelData | null {
  if (!isRecord(raw) || !Array.isArray(raw.fields) || !Array.isArray(raw.rows)) {
    return null;
  }
  if (raw.fields.length === 0 || raw.fields.length > MAX_STATIC_FIELDS) {
    return null;
  }
  const fields: StaticPanelData['fields'] = [];
  for (const f of raw.fields) {
    const type = isRecord(f) ? STATIC_FIELD_TYPES.find((candidate) => candidate === f.type) : undefined;
    if (!isRecord(f) || typeof f.name !== 'string' || !type) {
      return null;
    }
    fields.push({ name: f.name.slice(0, 100), type });
  }
  const rows: StaticPanelData['rows'] = [];
  for (const r of raw.rows.slice(0, MAX_STATIC_ROWS)) {
    if (!Array.isArray(r) || r.length !== fields.length) {
      return null;
    }
    rows.push(
      r.map((v, i) => {
        if (fields[i].type === 'string') {
          return typeof v === 'string'
            ? v.slice(0, MAX_STATIC_CELL_CHARS)
            : v == null
              ? null
              : String(v).slice(0, MAX_STATIC_CELL_CHARS);
        }
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
      })
    );
  }
  return { fields, rows };
}

/** Exported for tests: the spec/time/SQL gate that guards the terminal event. */
export function normalizeResult(payload: unknown): AssistantResult {
  const body: Record<string, unknown> = isRecord(payload) ? payload : {};
  let spec: GeneratedPanelSpec | null = null;

  if (isRecord(body.spec)) {
    const raw = body.spec;
    // The service already validates with zod; this guard only protects
    // against a version-skewed service returning an unknown shape.
    const panelType = SUPPORTED_PANEL_TYPES.find((candidate) => candidate === raw.panelType);
    const rawSql = typeof raw.rawSql === 'string' ? raw.rawSql.trim() : '';
    const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 120) : 'AI panel';
    // GA4 panel: no SQL to gate — the result travels as a static frame that
    // never reaches a datasource; it only has to be well-formed and bounded.
    const data = raw.source === 'ga4' ? normalizeStaticData(raw.data) : null;
    if (panelType && data) {
      spec = {
        panelType,
        title,
        rawSql: '',
        source: 'ga4',
        data,
        timeFrom: sanitizeTime(raw.timeFrom),
        timeTo: sanitizeTime(raw.timeTo),
      };
    }
    // Defense in depth: the panel query executes through the user's datasource
    // just like the bridge queries do, so it must clear the same read-only gate.
    // A hostile backend (reached via the localStorage URL override) can't smuggle
    // a mutating or SSRF-style statement in through the final spec.
    if (!spec && raw.source !== 'ga4' && panelType && rawSql !== '' && isSafeBridgeSql(rawSql)) {
      spec = {
        panelType,
        title,
        rawSql,
        timeFrom: sanitizeTime(raw.timeFrom),
        timeTo: sanitizeTime(raw.timeTo),
      };
    }
  }

  return {
    spec,
    message: typeof body.message === 'string' ? body.message : '',
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
    durationMs: typeof body.durationMs === 'number' ? body.durationMs : undefined,
    costUsd: typeof body.costUsd === 'number' ? body.costUsd : null,
  };
}
