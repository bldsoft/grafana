// Analytix: the CDN side of a problem, next to its chart. When the edge failed
// the same stream at the same time, the problem is confirmed by the CDN and
// the block says how (share of failed requests, codes, which CDN) with its own
// 5-minute chart; otherwise one line says the CDN served it as usual or has no
// logs for it. Read when the problem is opened, cached for the page.

import { css } from '@emotion/css';
import { createContext, useContext, useEffect, useState } from 'react';

import { DataSourceRef, GrafanaTheme2 } from '@grafana/data';
import { t } from '@grafana/i18n';
import { Badge, useStyles2, useTheme2 } from '@grafana/ui';
import { analytix } from 'app/features/home/analytixTokens';

import { BucketChart } from './BucketChart';
import { CDN_BEFORE_SEC, CDN_BUCKET_SEC, CdnCheck, CdnTarget, cdnStatusSql, evaluateCdn, toCdnStatus } from './cdn';
import { formatCount, formatUtcTime } from './format';
import { queryRows } from './query';

/** The ClickHouse datasource of the run, for reads a problem's details make on their own. */
export const AlertsDatasourceContext = createContext<DataSourceRef | undefined>(undefined);

type State = { status: 'loading' } | { status: 'done'; check: CdnCheck } | { status: 'error'; message: string };

const CACHE_LIMIT = 200;
const cache = new Map<string, CdnCheck>();

function cacheKey(ds: DataSourceRef, target: CdnTarget): string {
  return [ds.uid, target.pid, target.streams.join(','), target.from, target.to, target.start, target.end].join('|');
}

/** `12.3%`, one decimal below 10%. */
export function formatShare(share: number): string {
  const pct = share * 100;
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

export function CdnConfirmation({ target }: { target?: CdnTarget }) {
  const datasource = useContext(AlertsDatasourceContext);
  const key = datasource && target ? cacheKey(datasource, target) : undefined;
  const [state, setState] = useState<State>(() => {
    const hit = key ? cache.get(key) : undefined;
    return hit ? { status: 'done', check: hit } : { status: 'loading' };
  });

  useEffect(() => {
    if (!datasource || !target || !key) {
      return undefined;
    }
    const hit = cache.get(key);
    if (hit) {
      setState({ status: 'done', check: hit });
      return undefined;
    }
    setState({ status: 'loading' });
    const abort = new AbortController();
    queryRows(datasource, cdnStatusSql(target), { signal: abort.signal, timeoutMs: 35_000 })
      .then((rows) => {
        const check = evaluateCdn(rows.map(toCdnStatus), target);
        if (cache.size >= CACHE_LIMIT) {
          cache.delete(cache.keys().next().value!);
        }
        cache.set(key, check);
        if (!abort.signal.aborted) {
          setState({ status: 'done', check });
        }
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted) {
          setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
        }
      });
    return () => abort.abort();
    // `key` stands for the datasource and the target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!datasource || !target) {
    return null;
  }
  return <CdnBlock target={target} state={state} />;
}

function CdnBlock({ target, state }: { target: CdnTarget; state: State }) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const what = target.streams.length
    ? target.streams.join(', ')
    : t('ai-insider-alerts.cdn.all-streams', 'all streams of provider {{pid}}', { pid: target.pid });

  const label = <div className={styles.label}>{t('ai-insider-alerts.cdn.label', 'CDN logs')}</div>;

  if (state.status === 'loading') {
    return (
      <div className={styles.block}>
        {label}
        <span className={styles.faint}>{t('ai-insider-alerts.cdn.loading', 'Checking what the CDN saw…')}</span>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className={styles.block}>
        {label}
        <span className={styles.faint}>
          {t('ai-insider-alerts.cdn.error', 'The CDN logs could not be read on this datasource: {{error}}', {
            error: state.message,
            interpolation: { escapeValue: false },
          })}
        </span>
      </div>
    );
  }

  const { check } = state;
  if (check.verdict === 'none') {
    return (
      <div className={styles.block}>
        {label}
        <span className={styles.faint}>
          {t(
            'ai-insider-alerts.cdn.none',
            'No CDN logs for {{what}}: the stream goes through another CDN, or the provider is not in the CDN logs.',
            { what, interpolation: { escapeValue: false } }
          )}
        </span>
      </div>
    );
  }

  const share = check.requests ? check.errors / check.requests : 0;
  const before =
    check.shareBefore === undefined
      ? t('ai-insider-alerts.cdn.before-unknown', 'too little traffic before to compare')
      : t('ai-insider-alerts.cdn.before', '{{share}} in the {{minutes}} min before', {
          share: formatShare(check.shareBefore),
          minutes: CDN_BEFORE_SEC / 60,
        });

  if (check.verdict === 'clean') {
    return (
      <div className={styles.block}>
        {label}
        <div className={styles.line}>
          <Badge
            text={t('ai-insider-alerts.cdn.clean-badge', 'Not seen at the CDN')}
            color="darkgrey"
            tooltip={t(
              'ai-insider-alerts.cdn.clean-tip',
              'The edge answered this stream as usual while players failed: the cause is likely past the CDN (player, DRM, app) or in the stream content'
            )}
          />
          <span className={styles.faint}>
            {t(
              'ai-insider-alerts.cdn.clean',
              '{{what}}: {{share}} edge errors of {{requests}} requests during the problem ({{before}}).',
              {
                what,
                share: formatShare(share),
                requests: formatCount(check.requests),
                before,
                interpolation: { escapeValue: false },
              }
            )}
          </span>
        </div>
      </div>
    );
  }

  const codes = check.codes
    .slice(0, 4)
    .map((c) => `${c.status} ×${formatCount(c.requests)}`)
    .join(' · ');
  const cdns = check.cdns
    .filter((c) => c.requests > 0)
    .map((c) =>
      t('ai-insider-alerts.cdn.per-cdn', '{{cdn}}: {{share}} of {{requests}}', {
        cdn: c.cdn || '—',
        share: formatShare(c.errors / c.requests),
        requests: formatCount(c.requests),
      })
    )
    .join(' · ');

  return (
    <div className={styles.confirmed}>
      <div className={styles.line}>
        {label}
        <Badge
          text={t('ai-insider-alerts.cdn.confirmed-badge', 'Confirmed by the CDN')}
          color="red"
          icon="check"
          tooltip={t(
            'ai-insider-alerts.cdn.confirmed-tip',
            'The CDN edge answered the same stream with errors (4xx/5xx, client aborts excluded) at the same time, well above its level before'
          )}
        />
      </div>
      <div>
        {t(
          'ai-insider-alerts.cdn.confirmed',
          '{{what}}: {{share}} of {{requests}} requests failed at the edge during the problem ({{before}}).',
          {
            what,
            share: formatShare(share),
            requests: formatCount(check.requests),
            before,
            interpolation: { escapeValue: false },
          }
        )}
        <span className={styles.sub}>
          {t('ai-insider-alerts.cdn.codes', 'Codes: {{codes}}', { codes, interpolation: { escapeValue: false } })}
          {cdns && ` · ${cdns}`}
        </span>
      </div>
      <BucketChart
        bars={check.buckets.map((b) => ({
          start: b.bucket,
          value: b.requests ? b.errors / b.requests : 0,
          usual: check.shareBefore,
          tip: t('ai-insider-alerts.cdn.chart-tip', '{{time}} UTC · {{errors}} of {{requests}} requests failed', {
            time: formatUtcTime(b.bucket),
            errors: formatCount(b.errors),
            requests: formatCount(b.requests),
          }),
        }))}
        step={CDN_BUCKET_SEC}
        from={target.from}
        to={target.to}
        color={theme.colors.error.main}
        unit="share"
        label={t('ai-insider-alerts.cdn.chart-label', 'Share of CDN requests failed per 5 minutes')}
      />
      <div className={styles.faint}>
        {t(
          'ai-insider-alerts.cdn.chart-legend',
          'Bars: share of the CDN requests for the stream that failed at the edge, per 5 min ({{from}}–{{to}} UTC, from {{minutes}} min before the problem). Dashed: the level before.',
          { from: formatUtcTime(target.from), to: formatUtcTime(target.to), minutes: CDN_BEFORE_SEC / 60 }
        )}
      </div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  block: css({
    display: 'grid',
    gap: 2,
  }),
  confirmed: css({
    display: 'grid',
    gap: theme.spacing(1),
    padding: theme.spacing(1.5),
    borderRadius: analytix.radiusCard,
    border: `1px solid ${theme.colors.error.border}`,
    background: theme.colors.error.transparent,
  }),
  line: css({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.spacing(1),
  }),
  label: css({
    color: analytix.textMuted,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  faint: css({
    color: analytix.textFaint,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  sub: css({
    display: 'block',
    color: analytix.textFaint,
    fontSize: 12,
  }),
});
