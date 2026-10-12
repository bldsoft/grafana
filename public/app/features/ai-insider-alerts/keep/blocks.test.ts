import { blockFromFrame, blockFromRows, numAt, optNumAt, strAt } from './blocks';

const D = Date.UTC(2026, 9, 5) / 1000;
const DAY = 86400;

describe('blockFromRows', () => {
  it('turns rows into columns and leaves absent fields undefined', () => {
    const block = blockFromRows(D, 'full', [
      { pid: '111', account: 'AA-111-111', events: 40, plan: 'Premium' },
      { pid: '222', account: 'BB-222-222', events: 7 },
    ]);
    expect(block).toMatchObject({ day: D, level: 'full', from: D, to: D + DAY, length: 2 });
    expect(Array.from(block.column('events') ?? [])).toEqual([40, 7]);
    // A field one row lacks reads as missing there, never as 0.
    expect(block.column('plan')?.[1]).toBeUndefined();
    expect(block.column('seeds')).toBeUndefined();
  });

  it('keeps the part of the day a half block covers', () => {
    const block = blockFromRows(D, 'light', [], D, D + DAY / 2);
    expect(block).toMatchObject({ from: D, to: D + DAY / 2, length: 0 });
  });
});

describe('blockFromFrame', () => {
  it('reads the frame columns in place, without per-row objects', () => {
    const events = [40, 7];
    const frame = {
      length: 2,
      fields: [
        { name: 'pid', values: ['111', '222'] },
        { name: 'account', values: ['AA-111-111', 'BB-222-222'] },
        { name: 'events', values: events },
      ],
    };
    const block = blockFromFrame(D, 'full', frame, D, D + DAY);
    expect(block.length).toBe(2);
    expect(block.column('events')).toBe(events);
    expect(block.column('watch_all_min')).toBeUndefined();
  });

  it('converts time fields from epoch milliseconds to seconds', () => {
    const frame = {
      length: 2,
      fields: [{ name: 'last_ts', type: 'time', values: [(D + 60) * 1000, null] }],
    };
    const block = blockFromFrame(D, 'light', frame, D, D + DAY);
    expect(Array.from(block.column('last_ts') ?? [])).toEqual([D + 60, 0]);
  });

  it('tolerates a frame without fields or a usable length', () => {
    const block = blockFromFrame(
      D,
      'light',
      { length: Number.NaN, fields: [{ name: 'events', values: [1, 2, 3] }] },
      D,
      D + DAY
    );
    expect(block.length).toBe(3);
    expect(blockFromFrame(D, 'light', { length: 0, fields: [] }, D, D + DAY).length).toBe(0);
  });
});

describe('cell readers', () => {
  it('accept numbers that arrive as strings and treat null and garbage as missing', () => {
    const column = [5, '12', '1790000000', null, undefined, 'x', '', -3, true];
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => numAt(column, i))).toEqual([5, 12, 1790000000, 0, 0, 0, 0, 0, 1]);
    expect(Number.isNaN(optNumAt(column, 3))).toBe(true);
    expect(optNumAt(column, 7)).toBe(-3);
    expect(numAt(undefined, 0)).toBe(0);
    expect(strAt(['a', null, 7], 1)).toBe('');
    expect(strAt(['a', null, 7], 2)).toBe('7');
    expect(strAt(undefined, 0)).toBe('');
  });
});
