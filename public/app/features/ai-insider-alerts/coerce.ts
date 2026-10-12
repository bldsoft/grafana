// Analytix: AI Insider Alerts - tolerant readers of datasource cells. The
// ClickHouse plugins hand numbers back as numbers or strings (64-bit values)
// and NULL as null; the pages want plain numbers and strings.

/** A finite number, 0 for anything else. */
export const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** A string, '' for null / undefined. */
export const str = (v: unknown): string => (v == null ? '' : String(v));
