// Analytix: formatting helpers of the alerts page. Every time on the page is
// UTC: the event stream stores absolute instants and the replay range is
// entered in UTC, so a viewer in another zone reads the same clock as the data.

import type { Decision } from './types';

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `29 Sep 18:44` (UTC). */
export function formatUtc(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec)) {
    return '—';
  }
  const d = new Date(sec * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** `18:44` (UTC). */
export function formatUtcTime(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec)) {
    return '—';
  }
  const d = new Date(sec * 1000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Minutes between two instants, rounded, `—` when unknown. */
export function formatMinutes(from: number | undefined, to: number | undefined): string {
  if (from === undefined || to === undefined) {
    return '—';
  }
  const min = Math.round((to - from) / 60);
  return min >= 120 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}

/** Value for an <input type="datetime-local">, interpreted as UTC. */
export function toUtcInput(sec: number): string {
  const d = new Date(sec * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Parses an <input type="datetime-local"> value as UTC; NaN when invalid. */
export function fromUtcInput(value: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) {
    return NaN;
  }
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000;
}

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The decision log as CSV (UTC ISO times). */
export function decisionsToCsv(decisions: Decision[]): string {
  const header = [
    'time_utc',
    'message',
    'user',
    'provider_id',
    'provider',
    'channel_id',
    'channel',
    'platform',
    'incident',
    'reason',
  ];
  const lines = decisions.map((d) =>
    [
      new Date(d.at * 1000).toISOString(),
      d.kind,
      d.userId,
      d.pid,
      d.provider,
      d.cid,
      d.title,
      d.platform,
      d.incidentId ?? '',
      d.reason,
    ]
      .map((v) => csvCell(String(v)))
      .join(',')
  );
  return [header.join(','), ...lines].join('\n');
}
