// Analytix: the bar charts of the alerts page. One bar per time bucket, an
// optional dashed "usual level", a UTC time axis below and a value axis on the
// left. Drawn at the container's real width, so the axis text is not stretched
// the way a viewBox with preserveAspectRatio="none" would stretch it.

import { css } from '@emotion/css';
import { useMeasure } from 'react-use';

import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, useTheme2 } from '@grafana/ui';
import { analytix } from 'app/features/home/analytixTokens';

import { formatCount, formatUtc, formatUtcTime } from './format';

export interface ChartBar {
  /** Bucket start, epoch seconds. */
  start: number;
  value: number;
  /** The usual level at the same time (dashed line). */
  usual?: number;
  /** Hover text; the bucket's time and value when missing. */
  tip?: string;
}

/** 'share': values are 0..1, the axis goes to 100%. */
export type ChartUnit = 'count' | 'share';

interface Props {
  bars: ChartBar[];
  /** Bucket length, seconds. */
  step: number;
  /** Time range of the x axis; the first to the last bucket when missing. */
  from?: number;
  to?: number;
  color: string;
  unit?: ChartUnit;
  /** What the chart shows, for screen readers. */
  label: string;
}

const HEIGHT = 120;
const PAD_TOP = 8;
const PAD_RIGHT = 20;
const AXIS_H = 20;
const FONT = 10;
/** Before the first measurement (and in tests). */
const FALLBACK_WIDTH = 600;
/** Room for one time label, px; and no more labels than this even on a wide screen. */
const MIN_TICK_GAP = 64;
const MAX_TIME_TICKS = 12;
/** Steps of the time axis, seconds: 1 min … 1 day. */
const TIME_STEPS = [60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

/** Round ticks from 0 that cover `max`: three or four of them, whole numbers for counts. */
export function valueTicks(max: number, unit: ChartUnit = 'count'): number[] {
  if (unit === 'share') {
    return [0, 0.5, 1];
  }
  const target = Math.max(max, 1) / 3;
  const mag = 10 ** Math.floor(Math.log10(target));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= target) ?? 10 * mag);
  const ticks = [0];
  while (ticks.length < 2 || ticks[ticks.length - 1] < max) {
    ticks.push(ticks.length * step);
  }
  return ticks;
}

/**
 * Time ticks on round UTC times, at most `maxTicks` of them. The step is never
 * shorter than a bucket, so the ticks fall on bucket edges.
 */
export function timeTicks(from: number, to: number, minStep: number, maxTicks: number): number[] {
  const span = Math.max(1, to - from);
  const step =
    TIME_STEPS.find((s) => s >= minStep && span / s <= maxTicks) ?? Math.ceil(span / maxTicks / 86400) * 86400;
  const ticks: number[] = [];
  for (let s = Math.ceil(from / step) * step; s <= to; s += step) {
    ticks.push(s);
  }
  return ticks;
}

/** `950`, `1.2k`, `15k`, `2.4M`: short enough for the axis. */
export function compactCount(n: number): string {
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, '');
  if (n >= 1e6) {
    return `${trim(n / 1e6)}M`;
  }
  if (n >= 1e4) {
    return `${Math.round(n / 1e3)}k`;
  }
  if (n >= 1e3) {
    return `${trim(n / 1e3)}k`;
  }
  return String(Math.round(n));
}

/** `18:00–18:15`, or just `18:07` for one-minute buckets. */
export function bucketRange(start: number, step: number): string {
  return step <= 60 ? formatUtcTime(start) : `${formatUtcTime(start)}–${formatUtcTime(start + step)}`;
}

function timeLabel(sec: number): string {
  // Midnight names the day instead: "10 Oct" rather than "00:00".
  return sec % 86400 === 0 ? formatUtc(sec).slice(0, -6) : formatUtcTime(sec);
}

export function BucketChart({ bars, step, from, to, color, unit = 'count', label }: Props) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const [ref, { width: measured }] = useMeasure<HTMLDivElement>();
  const width = measured || FALLBACK_WIDTH;

  const x0 = from ?? bars[0]?.start ?? 0;
  const x1 = to ?? (bars.length ? bars[bars.length - 1].start + step : x0 + step);
  const max = Math.max(0, ...bars.map((b) => Math.max(b.value, b.usual ?? 0)));
  const yTicks = valueTicks(max, unit);
  const top = yTicks[yTicks.length - 1];
  const yLabel = (v: number) => (unit === 'share' ? `${Math.round(v * 100)}%` : compactCount(v));
  const left = Math.max(...yTicks.map((v) => yLabel(v).length)) * 6 + 12;
  const plotW = Math.max(1, width - left - PAD_RIGHT);
  const bottom = HEIGHT - AXIS_H;
  const plotH = bottom - PAD_TOP;
  const span = Math.max(1, x1 - x0);
  const x = (sec: number) => left + ((sec - x0) / span) * plotW;
  const y = (v: number) => bottom - (Math.min(Math.max(v, 0), top) / top) * plotH;
  const xTicks = timeTicks(x0, x1, step, Math.min(MAX_TIME_TICKS, Math.max(2, Math.floor(plotW / MIN_TICK_GAP))));

  const usual = bars.filter((b) => b.usual !== undefined);
  const line =
    usual.length === 1
      ? `M ${x(usual[0].start)} ${y(usual[0].usual ?? 0)} L ${x(usual[0].start + step)} ${y(usual[0].usual ?? 0)}`
      : usual.map((b, i) => `${i ? 'L' : 'M'} ${x(b.start + step / 2)} ${y(b.usual ?? 0)}`).join(' ');
  const text = { fontSize: FONT, fill: theme.colors.text.secondary };

  return (
    <div ref={ref} className={styles.wrap}>
      <svg width={width} height={HEIGHT} className={styles.svg} role="img" aria-label={label}>
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={left} x2={left + plotW} y1={y(v)} y2={y(v)} stroke={theme.colors.border.weak} />
            <text {...text} x={left - 6} y={y(v)} dy="0.35em" textAnchor="end">
              {yLabel(v)}
            </text>
          </g>
        ))}
        {bars.map((b) => {
          const bx = x(b.start);
          const bw = Math.max(1, x(b.start + step) - bx);
          const gap = bw > 6 ? 2 : bw > 2 ? 0.5 : 0;
          return (
            <g key={b.start} className={styles.bar}>
              <title>
                {b.tip ??
                  `${bucketRange(b.start, step)} UTC · ${unit === 'share' ? yLabel(b.value) : formatCount(b.value)}`}
              </title>
              <rect x={bx} y={PAD_TOP} width={bw} height={plotH} fill="transparent" />
              <rect
                x={bx + gap / 2}
                y={y(b.value)}
                width={Math.max(1, bw - gap)}
                height={bottom - y(b.value)}
                fill={color}
                opacity={0.85}
              />
            </g>
          );
        })}
        {line && (
          <path
            d={line}
            fill="none"
            stroke={theme.colors.text.primary}
            strokeWidth={1.5}
            strokeDasharray="4 3"
            pointerEvents="none"
          />
        )}
        <line x1={left} x2={left + plotW} y1={bottom} y2={bottom} stroke={theme.colors.border.medium} />
        {xTicks.map((s) => (
          <g key={s}>
            <line x1={x(s)} x2={x(s)} y1={bottom} y2={bottom + 4} stroke={theme.colors.border.medium} />
            <text {...text} x={x(s)} y={HEIGHT - 4} textAnchor="middle">
              {timeLabel(s)}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrap: css({
    width: '100%',
    minWidth: 0,
    background: analytix.surface,
    borderRadius: analytix.radiusControl,
  }),
  svg: css({
    display: 'block',
    overflow: 'visible',
    fontFamily: theme.typography.fontFamily,
    userSelect: 'none',
  }),
  // The full-height hit area of the hovered bucket lights up.
  bar: css({
    '&:hover rect:first-of-type': {
      fill: theme.colors.action.hover,
    },
  }),
});
