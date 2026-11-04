import { HOUR_SEC, HourRow, buildOverview, hourLevel, overviewWindow } from './overview';

const NOW = Date.UTC(2026, 10, 4, 10, 25) / 1000;

function hour(h: number, errUsers: number): HourRow {
  return {
    hour: h,
    users: 1000,
    errUsers,
    errEvents: errUsers * 3,
    srvErrUsers: 0,
    topPid: '222',
    topChannel: 'Sport 1',
  };
}

describe('last 24 hours overview', () => {
  it('ends with the running hour and reads the day before as the usual level', () => {
    const w = overviewWindow(NOW);
    expect(w.to).toBe(Date.UTC(2026, 10, 4, 11) / 1000);
    expect(w.to - w.from).toBe(24 * HOUR_SEC);
    expect(w.from - w.baseFrom).toBe(24 * HOUR_SEC);
  });

  it('marks hours well above the same hour yesterday, never small or running ones', () => {
    expect(hourLevel(100, 40)).toBe('hot');
    expect(hourLevel(70, 40)).toBe('warm');
    expect(hourLevel(50, 40)).toBe('normal');
    expect(hourLevel(10, 1)).toBe('normal');
    expect(hourLevel(100, undefined)).toBe('normal');

    const w = overviewWindow(NOW);
    const hot = w.from + 5 * HOUR_SEC;
    const running = w.to - HOUR_SEC;
    const o = buildOverview(
      [hour(hot, 120), hour(hot - 24 * HOUR_SEC, 30), hour(running, 500), hour(running - 24 * HOUR_SEC, 10)],
      w,
      NOW
    );
    expect(o.hours).toHaveLength(24);
    expect(o.hours[5]).toMatchObject({ level: 'hot', usualErrUsers: 30, partial: false });
    expect(o.hours[23]).toMatchObject({ level: 'normal', partial: true });
    expect(o.hours[0]).toMatchObject({ errUsers: 0, level: 'normal' });
  });
});
