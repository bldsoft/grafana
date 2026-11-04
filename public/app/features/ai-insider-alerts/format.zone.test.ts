import { formatAt, formatClock, setDisplayTimeZone, zoneLabel, zoneOffsetSec } from './format';

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
