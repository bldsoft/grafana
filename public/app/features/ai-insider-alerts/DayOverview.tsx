// Analytix: the "Last 24 hours" view of AI Insider Alerts: viewers with
// playback errors per hour against the same hour yesterday, the hours well
// above it in red, and a click on any hour to open it as a past period.

import { css } from '@emotion/css';

import { GrafanaTheme2 } from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import { Badge, useStyles2, useTheme2 } from '@grafana/ui';
import { analytix } from 'app/features/home/analytixTokens';

import { BucketChart, bucketRange } from './BucketChart';
import { formatAt, formatCount, zoneLabel } from './format';
import { HOT_FACTOR, HOT_MIN_ERR_USERS, HOUR_SEC, Overview, OverviewHour } from './overview';

function hourTip(h: OverviewHour): string {
  const usual =
    h.usualErrUsers === undefined
      ? ''
      : ` · ${t('ai-insider-alerts.day.tip-usual', 'yesterday {{usual}}', { usual: formatCount(h.usualErrUsers) })}`;
  const top = h.topChannel
    ? ` · ${t('ai-insider-alerts.day.tip-top', 'most on {{channel}} ({{pid}})', {
        channel: h.topChannel,
        pid: h.topPid,
        interpolation: { escapeValue: false },
      })}`
    : '';
  return `${bucketRange(h.hour, HOUR_SEC)} ${zoneLabel(h.hour)} · ${t(
    'ai-insider-alerts.day.tip-errors',
    '{{errors}} of {{viewers}} viewers with errors',
    { errors: formatCount(h.errUsers), viewers: formatCount(h.users) }
  )}${usual}${top}${h.partial ? ` · ${t('ai-insider-alerts.day.tip-partial', 'hour still running')}` : ''}`;
}

export function DayOverview({
  overview,
  loading,
  onHour,
  disabled,
  selected,
}: {
  overview: Overview;
  loading: boolean;
  /** Opens the hour (its start, epoch seconds) as a past period. */
  onHour: (hour: number) => void;
  disabled?: boolean;
  /** The hour open below, shaded on the chart. */
  selected?: number;
}) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const hot = overview.hours.filter((h) => h.level === 'hot');
  const color = (h: OverviewHour) =>
    h.level === 'hot' ? theme.colors.error.main : h.level === 'warm' ? theme.colors.warning.main : undefined;

  return (
    <section className={styles.card}>
      <div className={styles.head}>
        <strong>
          <Trans i18nKey="ai-insider-alerts.day.title">Last 24 hours</Trans>
        </strong>
        <span className={styles.faint}>
          {t('ai-insider-alerts.day.range', '{{from}} – {{to}} {{tz}}', {
            from: formatAt(overview.from),
            to: formatAt(overview.to),
            tz: zoneLabel(),
          })}
        </span>
        {loading && <span className={styles.faint}>{t('ai-insider-alerts.day.loading', 'reading the hours…')}</span>}
      </div>
      <BucketChart
        bars={overview.hours.map((h) => ({
          start: h.hour,
          value: h.errUsers,
          usual: h.usualErrUsers,
          color: color(h),
          tip: hourTip(h),
        }))}
        step={HOUR_SEC}
        from={overview.from}
        to={overview.to}
        color={theme.colors.text.secondary}
        label={t('ai-insider-alerts.day.chart-label', 'Viewers with playback errors per hour')}
        onBarClick={disabled ? undefined : onHour}
        highlight={selected === undefined ? undefined : { from: selected, to: selected + HOUR_SEC }}
      />
      <div className={styles.faint}>
        {t(
          'ai-insider-alerts.day.legend',
          'Bars: viewers with playback errors per hour, all providers in scope. Dashed: the same hour yesterday. Red: at least {{min}} viewers and {{factor}}× yesterday. Click an hour to open it with the full detection.',
          { min: HOT_MIN_ERR_USERS, factor: HOT_FACTOR }
        )}
      </div>
      {hot.length > 0 && (
        <div className={styles.hot}>
          {hot.map((h) => (
            <button
              key={h.hour}
              type="button"
              className={styles.hotItem}
              onClick={() => onHour(h.hour)}
              disabled={disabled}
            >
              <Badge text={bucketRange(h.hour, HOUR_SEC)} color="red" />
              <span>
                {t('ai-insider-alerts.day.hot-item', '{{errors}} viewers with errors', {
                  errors: formatCount(h.errUsers),
                })}
                {h.topChannel && <span className={styles.faint}> · {h.topChannel}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  card: css({
    background: analytix.surfaceRaised,
    border: `1px solid ${analytix.border}`,
    borderRadius: analytix.radiusPanel,
    padding: theme.spacing(2),
    display: 'grid',
    gap: theme.spacing(1),
  }),
  head: css({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: theme.spacing(1.5),
  }),
  faint: css({
    color: analytix.textMuted,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  hot: css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(1),
  }),
  hotItem: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    padding: theme.spacing(0.5, 1),
    border: `1px solid ${analytix.border}`,
    borderRadius: theme.shape.radius.default,
    background: 'transparent',
    color: theme.colors.text.primary,
    cursor: 'pointer',
    '&:hover': {
      background: theme.colors.action.hover,
    },
    '&:disabled': {
      cursor: 'not-allowed',
      opacity: 0.6,
    },
  }),
});
