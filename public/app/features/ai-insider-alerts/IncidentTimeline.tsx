import { css } from '@emotion/css';

import { GrafanaTheme2 } from '@grafana/data';
import { t } from '@grafana/i18n';
import { useStyles2, useTheme2 } from '@grafana/ui';

import { formatUtc, formatUtcTime } from './format';
import type { Incident, IncidentClass } from './types';

const MAX_ROWS = 40;
const ROW_H = 16;
const AXIS_H = 22;
const LABEL_W = 190;
const WIDTH = 1000;

interface Props {
  incidents: Incident[];
  classOf: (incident: Incident) => IncidentClass;
  from: number;
  to: number;
  onSelect: (id: string) => void;
}

export function classColor(theme: GrafanaTheme2, cls: IncidentClass): string {
  switch (cls) {
    case 'push':
      return theme.colors.error.main;
    case 'in_app':
      return theme.colors.warning.main;
    case 'pending':
      return theme.colors.info.main;
    case 'unstable':
      return theme.visualization.getColorByName('purple');
    default:
      return theme.colors.text.disabled;
  }
}

/**
 * Analytix: one lane per incident across the replayed window — when it
 * started, when the detector confirmed it (tick), when a push became due
 * (diamond) and when it recovered. The most impactful incidents only.
 */
export function IncidentTimeline({ incidents, classOf, from, to, onSelect }: Props) {
  const theme = useTheme2();
  const styles = useStyles2(getStyles);
  const span = Math.max(60, to - from);
  const rows = [...incidents]
    .sort((a, b) => b.peakErrUsers - a.peakErrUsers)
    .slice(0, MAX_ROWS)
    .sort((a, b) => a.start - b.start);
  const height = AXIS_H + rows.length * ROW_H + 4;
  const x = (sec: number) => LABEL_W + ((Math.min(Math.max(sec, from), to) - from) / span) * (WIDTH - LABEL_W - 8);

  const tickStep = span <= 6 * 3600 ? 3600 : span <= 2 * 86400 ? 3 * 3600 : 86400;
  const ticks: number[] = [];
  for (let s = Math.ceil(from / tickStep) * tickStep; s <= to; s += tickStep) {
    ticks.push(s);
  }

  if (!rows.length) {
    return null;
  }

  return (
    <div className={styles.wrap}>
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        className={styles.svg}
        role="img"
        aria-label={t('ai-insider-alerts.timeline-aria', 'Incident timeline')}
      >
        {ticks.map((s) => (
          <g key={s}>
            <line x1={x(s)} x2={x(s)} y1={AXIS_H - 4} y2={height} stroke={theme.colors.border.weak} />
            <text x={x(s)} y={12} fontSize={10} textAnchor="middle" fill={theme.colors.text.secondary}>
              {tickStep >= 86400 ? formatUtc(s).slice(0, -6) : formatUtcTime(s)}
            </text>
          </g>
        ))}
        {rows.map((inc, i) => {
          const y = AXIS_H + i * ROW_H;
          const end = inc.recovered === false ? inc.lastBad + 60 : (inc.closedAt ?? to);
          const color = classColor(theme, classOf(inc));
          const label = `${inc.provider || inc.pid} · ${inc.title || inc.cid}`;
          return (
            <g key={inc.id} className={styles.row} onClick={() => onSelect(inc.id)}>
              <title>{`${label}\n${formatUtc(inc.start)} → ${inc.closedAt ? formatUtc(inc.closedAt) : '…'}`}</title>
              <rect x={0} y={y} width={WIDTH} height={ROW_H} fill="transparent" />
              <text x={4} y={y + 11} fontSize={10} fill={theme.colors.text.primary}>
                {label.length > 32 ? `${label.slice(0, 31)}…` : label}
              </text>
              <rect
                x={x(inc.start)}
                y={y + 3}
                width={Math.max(2, x(end) - x(inc.start))}
                height={ROW_H - 6}
                rx={2}
                fill={color}
                opacity={0.85}
              />
              {inc.detectedAt !== undefined && (
                <line
                  x1={x(inc.detectedAt)}
                  x2={x(inc.detectedAt)}
                  y1={y + 1}
                  y2={y + ROW_H - 1}
                  stroke={theme.colors.text.primary}
                  strokeWidth={1.5}
                />
              )}
              {inc.escalatedAt !== undefined && (
                <path d={`M ${x(inc.escalatedAt)} ${y + 2} l 4 6 l -4 6 l -4 -6 z`} fill={theme.colors.text.primary} />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrap: css({
    overflowX: 'auto',
  }),
  svg: css({
    display: 'block',
    width: '100%',
    minWidth: 640,
    height: 'auto',
    fontFamily: theme.typography.fontFamily,
  }),
  row: css({
    cursor: 'pointer',
    '&:hover rect:first-of-type': {
      fill: theme.colors.action.hover,
    },
  }),
});
