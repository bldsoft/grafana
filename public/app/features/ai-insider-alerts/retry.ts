// Analytix: AI Insider Alerts - retries for transient datasource failures. A
// replay or an export runs hundreds of queries against the production
// ClickHouse; one 502 from the proxy in front of it must not throw away
// everything collected so far.

/** Gateway errors, timeouts and dropped connections: worth another try. */
const TRANSIENT_RE =
  /\b50[234]\b|bad gateway|gateway time-?out|service unavailable|timed? ?out|did not answer|econnreset|socket hang up|network error|failed to fetch/i;

export function isTransientError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e ?? '');
  return TRANSIENT_RE.test(message);
}

/** Default pauses between attempts: the proxy usually recovers within seconds. */
export const RETRY_DELAYS_MS = [3000, 10000, 30000];

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) {
      resolve();
      return;
    }
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

/** Runs `fn`, retrying transient failures after each delay in turn; other errors fail at once. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal,
  delaysMs: number[] = RETRY_DELAYS_MS
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (signal.aborted || !isTransientError(e) || attempt >= delaysMs.length) {
        throw e;
      }
      await sleep(delaysMs[attempt], signal);
    }
  }
}
