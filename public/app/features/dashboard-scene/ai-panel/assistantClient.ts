// Analytix: client for the ai-grafana-helper backend (SSE over POST).
// The backend lives in a separate private repository; it validates the SQL
// server-side and returns a ready GeneratedPanelSpec.

import { store } from '@grafana/data';

import { GeneratedPanelSpec, SUPPORTED_PANEL_TYPES } from './types';

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

export async function checkAssistantHealth(): Promise<{ ok: boolean; clickhouse: boolean }> {
  try {
    const res = await fetch(`${getAssistantBaseUrl()}/healthz`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      return { ok: false, clickhouse: false };
    }
    const body = await res.json();
    return { ok: Boolean(body.ok), clickhouse: Boolean(body.clickhouse) };
  } catch {
    return { ok: false, clickhouse: false };
  }
}

interface GenerateArgs {
  prompt: string;
  sessionId?: string | null;
  signal?: AbortSignal;
  onProgress?: (progress: AssistantProgress) => void;
}

/**
 * POST /api/generate and consume the SSE stream. Resolves with the terminal
 * `result` event; rejects on `error` events, HTTP errors or malformed specs.
 */
export async function generatePanel({ prompt, sessionId, signal, onProgress }: GenerateArgs): Promise<AssistantResult> {
  const res = await fetch(`${getAssistantBaseUrl()}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ prompt, sessionId: sessionId || undefined }),
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
    } else if (event === 'result') {
      result = normalizeResult(payload);
    } else if (event === 'error') {
      throw new Error(isRecord(payload) && typeof payload.message === 'string' ? payload.message : 'unknown error');
    }
  };

  // Minimal SSE parser: events are separated by a blank line; we only emit
  // single-line JSON payloads, so one `data:` line per event is guaranteed.
  const processChunk = (chunk: string) => {
    buffer += chunk;
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
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      processChunk(decoder.decode(value, { stream: true }));
    }
  } finally {
    // Release the connection if we bail out mid-stream (error event thrown).
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
    if (panelType && typeof raw.rawSql === 'string' && raw.rawSql.trim() !== '') {
      spec = {
        panelType,
        title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'AI panel',
        rawSql: raw.rawSql.trim(),
        timeFrom: typeof raw.timeFrom === 'string' ? raw.timeFrom : undefined,
        timeTo: typeof raw.timeTo === 'string' ? raw.timeTo : undefined,
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
