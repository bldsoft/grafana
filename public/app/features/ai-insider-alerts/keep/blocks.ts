// Analytix: AI Insider Alerts — "Keep the customer". Day blocks: one UTC day
// (or half of one) of account rows in columnar form. A day of a large
// provider is tens of thousands of rows; turning each into an object only to
// copy it into the engine's typed arrays would double the memory of a scan, so
// a block hands out the datasource frame's own column arrays and the engine
// reads them by index.

import type { AccountDayRow, DayBlock, DayLevel, FrameLike } from './types';

const DAY = 86400;
/** Values of a time field above this are epoch milliseconds, not seconds. */
const EPOCH_MS_FLOOR = 1e11;

/** A day block from row objects (tests, imports). */
export function blockFromRows(
  day: number,
  level: DayLevel,
  rows: Array<Partial<AccountDayRow>>,
  from = day,
  to = day + DAY
): DayBlock {
  const columns = new Map<string, unknown[]>();
  rows.forEach((row, i) => {
    for (const [name, value] of Object.entries(row)) {
      let column = columns.get(name);
      if (!column) {
        // Rows that lack the field read as undefined (= missing), never as 0.
        column = new Array(rows.length);
        columns.set(name, column);
      }
      column[i] = value;
    }
  });
  return { day, level, from, to, length: rows.length, column: (name) => columns.get(name) };
}

/** A day block over a datasource frame's own column arrays. */
export function blockFromFrame(day: number, level: DayLevel, frame: FrameLike, from: number, to: number): DayBlock {
  const columns = new Map<string, ArrayLike<unknown>>();
  let longest = 0;
  for (const field of frame?.fields ?? []) {
    const values = field?.values;
    if (!field?.name || !values || typeof values.length !== 'number' || columns.has(field.name)) {
      continue;
    }
    columns.set(field.name, isTimeField(field) ? timeToSeconds(values) : values);
    longest = Math.max(longest, values.length);
  }
  const length = Number.isFinite(frame?.length) && frame.length >= 0 ? frame.length : longest;
  return { day, level, from, to, length, column: (name) => columns.get(name) };
}

/**
 * The SQL returns epoch numbers, but a plugin that types a column as time hands
 * out epoch milliseconds; the engine works in seconds.
 */
function isTimeField(field: FrameLike['fields'][number]): boolean {
  return 'type' in field && field.type === 'time';
}

function timeToSeconds(values: ArrayLike<unknown>): Float64Array {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = cellNumber(values[i]);
    out[i] = Number.isFinite(v) ? (Math.abs(v) >= EPOCH_MS_FLOOR ? Math.floor(v / 1000) : v) : 0;
  }
  return out;
}

/**
 * A cell as a number: numbers as they are, 64-bit values that arrive as
 * strings parsed, anything else (null, '', garbage) NaN.
 */
export function cellNumber(v: unknown): number {
  if (typeof v === 'number') {
    return v;
  }
  if (typeof v === 'string') {
    return v.trim() === '' ? NaN : Number(v);
  }
  if (typeof v === 'bigint') {
    return Number(v);
  }
  if (typeof v === 'boolean') {
    return v ? 1 : 0;
  }
  return NaN;
}

/** A count or a sum: 0 for missing and invalid values, never negative. */
export function numAt(column: ArrayLike<unknown> | undefined, i: number): number {
  if (!column) {
    return 0;
  }
  const v = cellNumber(column[i]);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** A value that may be missing (NaN), as opposed to zero. */
export function optNumAt(column: ArrayLike<unknown> | undefined, i: number): number {
  if (!column) {
    return NaN;
  }
  const v = cellNumber(column[i]);
  return Number.isFinite(v) ? v : NaN;
}

/** A string cell, '' for null / undefined. */
export function strAt(column: ArrayLike<unknown> | undefined, i: number): string {
  if (!column) {
    return '';
  }
  const v = column[i];
  return v == null ? '' : String(v);
}
