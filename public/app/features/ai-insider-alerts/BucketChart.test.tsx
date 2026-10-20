import { render, screen } from '@testing-library/react';

import { BucketChart, bucketRange, compactCount, timeTicks, valueTicks } from './BucketChart';

const T = Date.UTC(2026, 9, 10, 18, 0) / 1000;

describe('valueTicks', () => {
  it('covers the maximum with round whole steps', () => {
    expect(valueTicks(520)).toEqual([0, 200, 400, 600]);
    expect(valueTicks(7)).toEqual([0, 5, 10]);
    expect(valueTicks(2)).toEqual([0, 1, 2]);
  });

  it('still has an axis when everything is zero', () => {
    expect(valueTicks(0)).toEqual([0, 1]);
  });

  it('goes to 100% for shares', () => {
    expect(valueTicks(0.3, 'share')).toEqual([0, 0.5, 1]);
  });
});

describe('timeTicks', () => {
  it('puts ticks on bucket edges', () => {
    expect(timeTicks(T, T + 45 * 60, 900, 10)).toEqual([T, T + 900, T + 1800, T + 2700]);
  });

  it('takes a longer step when the labels would not fit', () => {
    const ticks = timeTicks(T, T + 6 * 3600, 60, 6);
    expect(ticks).toHaveLength(7);
    expect(ticks[1] - ticks[0]).toBe(3600);
  });
});

describe('labels', () => {
  it('shortens counts and names bucket ranges', () => {
    expect(compactCount(950)).toBe('950');
    expect(compactCount(1200)).toBe('1.2k');
    expect(compactCount(15000)).toBe('15k');
    expect(compactCount(2_400_000)).toBe('2.4M');
    expect(bucketRange(T, 900)).toBe('18:00–18:15');
    expect(bucketRange(T, 60)).toBe('18:00');
  });
});

describe('BucketChart', () => {
  it('draws the time and value axes and a tip per bar', () => {
    render(
      <BucketChart
        bars={[
          { start: T, value: 300, usual: 100 },
          { start: T + 900, value: 520, usual: 110, tip: 'second bucket' },
          { start: T + 1800, value: 280, usual: 120 },
        ]}
        step={900}
        color="red"
        label="Viewers with errors"
      />
    );

    expect(screen.getByRole('img', { name: 'Viewers with errors' })).toBeInTheDocument();
    for (const time of ['18:00', '18:15', '18:30', '18:45']) {
      expect(screen.getByText(time)).toBeInTheDocument();
    }
    for (const value of ['0', '200', '400', '600']) {
      expect(screen.getByText(value)).toBeInTheDocument();
    }
    expect(screen.getByText('18:00–18:15 UTC · 300')).toBeInTheDocument();
    expect(screen.getByText('second bucket')).toBeInTheDocument();
  });
});
