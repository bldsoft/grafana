// Analytix: AI Insider Alerts - the last 24 hours at a glance. One bar per
// hour of viewers with playback errors over the whole scope, against the same
// hour the day before; hours well above it are marked, and a click opens the
// hour as a past period with the full detector. Read in 6-hour pieces so no
// single statement scans a whole day.

import { DataSourceRef } from '@grafana/data';

import { num, str } from './coerce';
import { queryRows } from './query';
import { hourlyOverviewSql } from './sql';

export const HOUR_SEC = 3600;
export const OVERVIEW_HOURS = 24;
const PIECE_SEC = 6 * HOUR_SEC;

/** A hot hour: at least this many viewers with errors… */
export const HOT_MIN_ERR_USERS = 20;
/** …and this many times the same hour yesterday (red); WARM_FACTOR = orange. */
export const HOT_FACTOR = 2;
export const WARM_FACTOR = 1.5;

export interface HourRow {
  hour: number;
  users: number;
  errUsers: number;
  errEvents: number;
  srvErrUsers: number;
  topPid: string;
  topChannel: string;
}

export type HourLevel = 'hot' | 'warm' | 'normal';

export interface OverviewHour extends HourRow {
  /** The same hour the day before; undefined when it was not read. */
  usualErrUsers?: number;
  level: HourLevel;
  /** The hour is still running (the last bar). */
  partial: boolean;
}

export interface Overview {
  /** Start of the first hour shown and end of the last (exclusive). */
  from: number;
  to: number;
  hours: OverviewHour[];
}

export function toHourRow(r: Record<string, unknown>): HourRow {
  return {
    hour: num(r.hour_ts),
    users: num(r.users),
    errUsers: num(r.err_users),
    errEvents: num(r.err_events),
    srvErrUsers: num(r.srv_err_users),
    topPid: str(r.top_pid),
    topChannel: str(r.top_channel),
  };
}

/** The 24 hours shown, ending with the running hour, and the 24 before them. */
export function overviewWindow(now: number): { from: number; to: number; baseFrom: number } {
  const to = Math.floor(now / HOUR_SEC) * HOUR_SEC + HOUR_SEC;
  const from = to - OVERVIEW_HOURS * HOUR_SEC;
  return { from, to, baseFrom: from - OVERVIEW_HOURS * HOUR_SEC };
}

export function hourLevel(errUsers: number, usual: number | undefined): HourLevel {
  if (errUsers < HOT_MIN_ERR_USERS) {
    return 'normal';
  }
  // With nothing to compare against, only a big hour counts as warm.
  const base = Math.max(usual ?? errUsers, 1);
  return errUsers >= HOT_FACTOR * base ? 'hot' : errUsers >= WARM_FACTOR * base ? 'warm' : 'normal';
}

/** Every hour of the window (empty ones as zeros) with its level against the day before. */
export function buildOverview(rows: HourRow[], window: { from: number; to: number }, now: number): Overview {
  const byHour = new Map(rows.map((r) => [r.hour, r]));
  const hours: OverviewHour[] = [];
  for (let h = window.from; h < window.to; h += HOUR_SEC) {
    const row = byHour.get(h) ?? {
      hour: h,
      users: 0,
      errUsers: 0,
      errEvents: 0,
      srvErrUsers: 0,
      topPid: '',
      topChannel: '',
    };
    const usual = byHour.get(h - OVERVIEW_HOURS * HOUR_SEC)?.errUsers;
    const partial = h + HOUR_SEC > now;
    hours.push({ ...row, usualErrUsers: usual, level: partial ? 'normal' : hourLevel(row.errUsers, usual), partial });
  }
  return { from: window.from, to: window.to, hours };
}

/**
 * Reads the overview: the 48 hours in 6-hour pieces, the newest first, so the
 * bars fill in from the right while the rest is read.
 */
export async function loadOverview(opts: {
  datasource: DataSourceRef;
  pids: string[] | null;
  now: number;
  signal?: AbortSignal;
  onPiece?: (overview: Overview) => void;
}): Promise<Overview> {
  const win = overviewWindow(opts.now);
  const rows: HourRow[] = [];
  for (let end = win.to; end > win.baseFrom; end -= PIECE_SEC) {
    const start = Math.max(win.baseFrom, end - PIECE_SEC);
    const piece = await queryRows(opts.datasource, hourlyOverviewSql(start, end, opts.pids), {
      signal: opts.signal,
      maxRows: 1000,
    });
    rows.push(...piece.map(toHourRow));
    opts.onPiece?.(buildOverview(rows, win, opts.now));
  }
  return buildOverview(rows, win, opts.now);
}
