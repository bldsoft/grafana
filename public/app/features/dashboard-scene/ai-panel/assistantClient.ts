// Analytix: client for the ai-grafana-helper backend (SSE over POST).
// The backend lives in a separate private repository; it validates the SQL
// server-side and returns a ready GeneratedPanelSpec.

import { DataSourceRef, store } from '@grafana/data';
import { config } from '@grafana/runtime';

import { isSafeBridgeSql, runRawQuery } from './datasourceQuery';
import { GeneratedPanelSpec, SUPPORTED_PANEL_TYPES } from './types';

// Silence watchdog: the backend sends an SSE heartbeat every 15s, so no bytes
// at all for this long means the connection died silently (dropped tunnel,
// laptop sleep, NAT timeout) — surface an error instead of spinning forever.
const SSE_IDLE_TIMEOUT_MS = 40000;

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

const DEFAULT_URL = 'http://localhost:8765';
const URL_OVERRIDE_KEY = 'analytix.aiAssistantUrl';
const TOKEN_KEY = 'analytix.aiAssistantToken';

export function getAssistantBaseUrl(): string {
  try {
    return store.get(URL_OVERRIDE_KEY) || DEFAULT_URL;
  } catch {
    return DEFAULT_URL;
  }
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
          kind:
            typeof item.kind === 'string' && item.kind ? item.kind.slice(0, MAX_SUGGESTION_KIND_CHARS) : 'summary',
        });
      }
    }
    return suggestions;
  } catch {
    return [];
  }
}

interface GenerateArgs {
  prompt: string;
  /** ClickHouse datasource that executes the agent's exploration queries (and later the panel). */
  datasource: DataSourceRef;
  sessionId?: string | null;
  signal?: AbortSignal;
  onProgress?: (progress: AssistantProgress) => void;
}

/**
 * Browser leg of the query bridge: execute the SQL from a `query` SSE event
 * through the user's datasource and POST the result back to the backend.
 * Errors are shipped back too — the agent reads them and self-corrects.
 */
async function answerQueryEvent(datasource: DataSourceRef, payload: Record<string, unknown>): Promise<void> {
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
    const result = await runRawQuery(datasource, sql, maxRows);
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
export async function generatePanel({ prompt, datasource, sessionId, signal, onProgress }: GenerateArgs): Promise<AssistantResult> {
  const res = await fetch(`${getAssistantBaseUrl()}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    // `user` attributes the request in the backend audit log; access control
    // stays on the bearer token.
    body: JSON.stringify({ prompt, sessionId: sessionId || undefined, user: config.bootData?.user?.login || undefined }),
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
      void answerQueryEvent(datasource, payload);
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

function normalizeResult(payload: unknown): AssistantResult {
  const body: Record<string, unknown> = isRecord(payload) ? payload : {};
  let spec: GeneratedPanelSpec | null = null;

  if (isRecord(body.spec)) {
    const raw = body.spec;
    // The service already validates with zod; this guard only protects
    // against a version-skewed service returning an unknown shape.
    const panelType = SUPPORTED_PANEL_TYPES.find((candidate) => candidate === raw.panelType);
    const rawSql = typeof raw.rawSql === 'string' ? raw.rawSql.trim() : '';
    // Defense in depth: the panel query executes through the user's datasource
    // just like the bridge queries do, so it must clear the same read-only gate.
    // A hostile backend (reached via the localStorage URL override) can't smuggle
    // a mutating or SSRF-style statement in through the final spec.
    if (panelType && rawSql !== '' && isSafeBridgeSql(rawSql)) {
      spec = {
        panelType,
        title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'AI panel',
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
