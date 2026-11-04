// Analytix: formatting helpers of the alerts page. The event stream stores
// absolute instants; the page shows them in one display time zone, picked
// next to the time range (UTC by default), and every label names it. The
// Retention section and the prompts for the AI Insider chat keep plain UTC
// (formatUtc / toUtcInput): their days are UTC days.

import type { Decision } from './types';

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Grafana's time zone values: 'utc', 'browser' (or '') or an IANA name. */
let displayZone = 'utc';

/** The IANA name Intl takes; undefined for the browser's own zone. */
function intlZone(zone: string): string | undefined {
  if (zone === 'utc' || zone === 'UTC') {
    return 'UTC';
  }
  return !zone || zone === 'browser' ? undefined : zone;
}

function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: intlZone(zone) });
    return true;
  } catch {
    return false;
  }
}

/** Sets the zone every alerts time is shown in; an unknown zone falls back to UTC. */
export function setDisplayTimeZone(zone: string | undefined): void {
  const next = zone && isValidZone(zone) ? zone : 'utc';
  if (next !== displayZone) {
    displayZone = next;
    partsFormatter = undefined;
  }
}

export function getDisplayTimeZone(): string {
  return displayZone;
}

let partsFormatter: Intl.DateTimeFormat | undefined;

/** Wall-clock fields of an instant in the display zone. */
function zoned(sec: number): { year: number; month: number; day: number; hour: number; minute: number } {
  const zone = intlZone(displayZone);
  if (zone === 'UTC') {
    const d = new Date(sec * 1000);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth(),
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
    };
  }
  partsFormatter ??= new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  });
  const parts: Record<string, number> = {};
  for (const p of partsFormatter.formatToParts(new Date(sec * 1000))) {
    if (p.type !== 'literal') {
      parts[p.type] = Number(p.value);
    }
  }
  return { year: parts.year, month: parts.month - 1, day: parts.day, hour: parts.hour % 24, minute: parts.minute };
}

/** Seconds the display zone is ahead of UTC at that instant (UTC+3 → 10800). */
export function zoneOffsetSec(sec: number): number {
  const z = zoned(sec);
  const wall = Date.UTC(z.year, z.month, z.day, z.hour, z.minute) / 1000;
  return wall - Math.floor(sec / 60) * 60;
}

/** The display zone as labels name it: `UTC`, `UTC+3`, `UTC−4:30`. */
export function zoneLabel(at = Date.now() / 1000): string {
  if (intlZone(displayZone) === 'UTC') {
    return 'UTC';
  }
  const off = Math.round(zoneOffsetSec(at) / 60);
  if (!off) {
    return 'UTC';
  }
  const abs = Math.abs(off);
  const hm = abs % 60 ? `${Math.floor(abs / 60)}:${pad(abs % 60)}` : String(abs / 60);
  return `UTC${off > 0 ? '+' : '−'}${hm}`;
}

/** `29 Sep 18:44` in the display zone. */
export function formatAt(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec)) {
    return '—';
  }
  const z = zoned(sec);
  return `${z.day} ${MONTHS[z.month]} ${pad(z.hour)}:${pad(z.minute)}`;
}

/** Start of the run on screen; undefined when there is none. */
let spanFrom: number | undefined;

/**
 * Sets the start of the run the page shows. A time of a run that started on
 * an earlier day (a past period, the last 24 hours, Live past midnight) is
 * ambiguous without its date: formatWhen then adds it.
 */
export function setDisplaySpan(from: number | undefined): void {
  spanFrom = from !== undefined && Number.isFinite(from) ? from : undefined;
}

function dayOf(sec: number): number {
  const z = zoned(sec);
  return z.year * 10000 + z.month * 100 + z.day;
}

/** True when the run on screen did not start today (in the display zone). */
export function datesNeeded(now = Date.now() / 1000): boolean {
  return spanFrom !== undefined && dayOf(spanFrom) !== dayOf(now);
}

/** `29 Sep 18:44` when the run spans other days than today, `18:44` otherwise. */
export function formatWhen(sec: number | undefined): string {
  return datesNeeded() ? formatAt(sec) : formatClock(sec);
}

/**
 * The end of a span that starts at `start`: `19:10` on the same day (it
 * follows a dated start), `30 Sep 01:10` when it runs past midnight.
 */
export function formatUntil(start: number | undefined, end: number | undefined): string {
  if (end === undefined || !Number.isFinite(end)) {
    return '—';
  }
  if (start === undefined || !Number.isFinite(start)) {
    return formatWhen(end);
  }
  return dayOf(start) === dayOf(end) ? formatClock(end) : formatAt(end);
}

/** `18:44` in the display zone, no date: chart axes and spans already dated. */
export function formatClock(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec)) {
    return '—';
  }
  const z = zoned(sec);
  return `${pad(z.hour)}:${pad(z.minute)}`;
}

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

/** Top entries of a breakdown with their counts: "a (12), b (3)". */
export function breakdown(map: Record<string, number>, limit = 4) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, v]) => `${k || '—'} (${v})`)
    .join(', ');
}

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * One CSV cell. A cell starting with `= + - @`, a tab or a carriage return is
 * a formula to a spreadsheet (titles and ids come from the event stream, so
 * anyone can plant one): it gets a leading `'` and is read as text.
 */
export function csvCell(value: string): string {
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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
