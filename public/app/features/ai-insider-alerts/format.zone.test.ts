import {
  datesNeeded,
  formatAt,
  formatClock,
  formatUntil,
  formatWhen,
  setDisplaySpan,
  setDisplayTimeZone,
  zoneLabel,
  zoneOffsetSec,
} from './format';

const T = Date.UTC(2026, 9, 29, 18, 44) / 1000;

describe('display time zone', () => {
  afterEach(() => setDisplayTimeZone('utc'));

  it('shows UTC by default', () => {
    expect(formatAt(T)).toBe('29 Oct 18:44');
    expect(formatClock(T)).toBe('18:44');
    expect(zoneLabel(T)).toBe('UTC');
    expect(zoneOffsetSec(T)).toBe(0);
  });

  it('shows every time and label in the zone picked', () => {
    setDisplayTimeZone('Europe/Minsk');
    expect(formatAt(T)).toBe('29 Oct 21:44');
    expect(formatClock(T)).toBe('21:44');
    expect(zoneLabel(T)).toBe('UTC+3');
    expect(zoneOffsetSec(T)).toBe(3 * 3600);

    setDisplayTimeZone('Asia/Kolkata');
    expect(formatClock(T)).toBe('00:14');
    expect(formatAt(T)).toBe('30 Oct 00:14');
    expect(zoneLabel(T)).toBe('UTC+5:30');

    setDisplayTimeZone('America/New_York');
    expect(zoneLabel(T)).toBe('UTC−4');
  });

  it('falls back to UTC for an unknown zone', () => {
    setDisplayTimeZone('Mars/Olympus');
    expect(formatClock(T)).toBe('18:44');
    expect(zoneLabel(T)).toBe('UTC');
  });
});

describe('dates on a run that spans days', () => {
  afterEach(() => {
    setDisplaySpan(undefined);
    setDisplayTimeZone('utc');
  });

  it('dates the times of a run that started on an earlier day, not of one started today', () => {
    const now = Date.now() / 1000;
    expect(formatWhen(T)).toBe('18:44');
    setDisplaySpan(now - 60);
    // Started a minute ago: today, unless the test runs right after midnight.
    expect(datesNeeded(now)).toBe(formatAt(now - 60).slice(0, -6) !== formatAt(now).slice(0, -6));
    setDisplaySpan(T - 2 * 86400);
    expect(datesNeeded(now)).toBe(true);
    expect(formatWhen(T)).toBe('29 Oct 18:44');
  });

  it('ends a span with the time alone on the same day and with the date past midnight', () => {
    expect(formatUntil(T, T + 26 * 60)).toBe('19:10');
    expect(formatUntil(T, T + 7 * 3600)).toBe('30 Oct 01:44');
    expect(formatUntil(T, undefined)).toBe('—');
    setDisplaySpan(T - 86400);
    expect(formatUntil(undefined, T)).toBe('29 Oct 18:44');
    // Midnight in the display zone, not in UTC.
    setDisplayTimeZone('Asia/Tokyo');
    expect(formatUntil(T - 3600, T)).toBe('03:44');
    expect(formatUntil(T - 4 * 3600, T)).toBe('30 Oct 03:44');
  });
});
