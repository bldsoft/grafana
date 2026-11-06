// Analytix: who was hit, in the support view. The viewers of a problem as a
// table with a column per fact support asks the caller about (device, OS, app
// build, network, IP, device ids, the error in words), sortable and filtered
// by any of them; the profile of one looked-up viewer; and the cohorts of a
// problem (which platform, model, build, OS, ISP its errors fall on).

import { css, cx } from '@emotion/css';
import { ReactNode, useMemo } from 'react';

import { GrafanaTheme2 } from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import { useStyles2 } from '@grafana/ui';
import { analytix } from 'app/features/home/analytixTokens';

import { getStyles as getResultStyles } from './AlertsResults';
import { ColumnFilter, FilterColumn, useColumnFilter } from './ColumnFilter';
import { ErrorCell } from './ErrorText';
import { ViewerId, viewerKindText } from './ViewerId';
import { ErrorDictionary, describeError, errorKeyText, useErrorDictionary } from './errorCodes';
import { formatCount, formatWhen, zoneLabel } from './format';
import { SortHeader, SortValue, useTableSort } from './sortableTable';
import { ViewerFacts, channelValues, detailValues, mergeDetail } from './support';
import type { AffectedUserRow, CustomerSideRow, ViewerDetail } from './types';

const VIEWERS_LIMIT = 100;
const EMPTY = '—';

/** `a, b` → `a, b`; empty → `—`. */
function list(value: string | undefined): string {
  return detailValues(value).join(', ') || '—';
}

/** Columns a viewer table can be filtered by; `of` reads the viewer row out of a table row. */
export function viewerFilterColumns<T>(
  of: (row: T) => ViewerFacts,
  dict: ErrorDictionary | undefined
): Array<FilterColumn<T>> {
  return [
    {
      key: 'account',
      label: t('ai-insider-alerts.filter.col-account', 'Account'),
      values: (r) => [of(r).userId, ...detailValues(of(r).accounts)],
    },
    {
      key: 'channel',
      label: t('ai-insider-alerts.filter.col-channel', 'Channel'),
      values: (r) => channelValues(of(r).channelTitles),
    },
    { key: 'platform', label: t('ai-insider-alerts.filter.col-platform', 'Platform'), values: (r) => [of(r).platform] },
    {
      key: 'model',
      label: t('ai-insider-alerts.filter.col-model', 'Model'),
      values: (r) => detailValues(of(r).models),
    },
    { key: 'os', label: t('ai-insider-alerts.filter.col-os', 'OS'), values: (r) => detailValues(of(r).os) },
    {
      key: 'app',
      label: t('ai-insider-alerts.filter.col-app', 'App version'),
      values: (r) => detailValues(of(r).appVersions),
    },
    { key: 'network', label: t('ai-insider-alerts.filter.col-network', 'Network'), values: (r) => [of(r).network] },
    { key: 'isp', label: t('ai-insider-alerts.filter.col-isp', 'ISP'), values: (r) => [of(r).isp] },
    { key: 'city', label: t('ai-insider-alerts.filter.col-city', 'City'), values: (r) => [of(r).city] },
    { key: 'ip', label: t('ai-insider-alerts.filter.col-ip', 'IP'), values: (r) => detailValues(of(r).ips) },
    {
      key: 'serial',
      label: t('ai-insider-alerts.filter.col-serial', 'Serial'),
      values: (r) => detailValues(of(r).serials),
    },
    {
      key: 'deviceId',
      label: t('ai-insider-alerts.filter.col-device-id', 'Device ID'),
      values: (r) => detailValues(of(r).deviceIds),
    },
    {
      key: 'error',
      label: t('ai-insider-alerts.filter.col-error', 'Error'),
      values: (r) => [of(r).topCode ? errorKeyText(of(r).topCode) : undefined],
      hint: (_, r) => describeError(dict, of(r).topCode, of(r).platform),
    },
  ];
}

function DeviceCell({ row }: { row: AffectedUserRow }) {
  const styles = useStyles2(getResultStyles);
  return (
    <>
      {row.platform || '—'}
      <span className={styles.sub}>{list(row.models)}</span>
    </>
  );
}

function NetworkCell({ row }: { row: { network: string; isp: string; city: string } }) {
  const styles = useStyles2(getResultStyles);
  return (
    <>
      {row.network || '—'}
      <span className={styles.sub}>{[row.isp, row.city].filter(Boolean).join(' · ') || '—'}</span>
    </>
  );
}

/** The channels a viewer had errors on (problems wider than one channel). */
export function ChannelsCell({ row }: { row: { channelTitles?: string; channelCount?: number } }) {
  const styles = useStyles2(getResultStyles);
  const titles = channelValues(row.channelTitles);
  if (!titles.length) {
    return <>{EMPTY}</>;
  }
  const more = (row.channelCount ?? titles.length) - titles.length;
  return (
    <>
      {titles.join(', ')}
      {more > 0 && (
        <span className={styles.sub}>
          {t('ai-insider-alerts.viewers.channels-more', '+{{count}} more', { count: more })}
        </span>
      )}
    </>
  );
}

function IdsCell({ row }: { row: ViewerDetail }) {
  const styles = useStyles2(getResultStyles);
  const local = useStyles2(getStyles);
  const serials = detailValues(row.serials);
  const ids = detailValues(row.deviceIds);
  if (!serials.length && !ids.length) {
    return <>—</>;
  }
  return (
    <span className={cx(styles.mono, local.ids)}>
      {serials.map((s) => (
        <span key={`s-${s}`} title={t('ai-insider-alerts.viewers.serial', 'Device serial number')}>
          {s}
        </span>
      ))}
      {ids.map((s) => (
        <span
          key={`d-${s}`}
          className={styles.sub}
          title={t('ai-insider-alerts.viewers.device-id', 'Device ID (server)')}
        >
          {s}
        </span>
      ))}
    </span>
  );
}

/** The viewers hit by one problem, a column per fact, sortable and filtered by any of them. */
export function AffectedViewersTable({
  viewers,
  onViewer,
  told,
  toldSort,
}: {
  viewers: AffectedUserRow[];
  onViewer: (userId: string) => void;
  /** What the viewer was told about the problem. */
  told: (row: AffectedUserRow) => ReactNode;
  /** Sort key of the "Told" column. */
  toldSort: (row: AffectedUserRow) => SortValue;
}) {
  const styles = useStyles2(getResultStyles);
  const local = useStyles2(getStyles);
  const dict = useErrorDictionary();
  // Only a problem wider than one channel has a channel per viewer.
  const withChannels = viewers.some((u) => u.channelTitles);
  const columns = useMemo(
    () => viewerFilterColumns((u: AffectedUserRow) => u, dict).filter((c) => withChannels || c.key !== 'channel'),
    [dict, withChannels]
  );
  const { filter, rows: filtered } = useColumnFilter(viewers, columns);
  const { rows, sort } = useTableSort(filtered, {
    viewer: (u) => u.userId,
    channels: (u) => channelValues(u.channelTitles)[0],
    device: (u) => `${u.platform} ${u.models ?? ''}`,
    os: (u) => u.os,
    app: (u) => u.appVersions,
    network: (u) => `${u.network} ${u.isp}`,
    ip: (u) => u.ips,
    ids: (u) => u.serials || u.deviceIds,
    firstErr: (u) => u.firstErr,
    errors: (u) => u.errEvents,
    error: (u) => u.topCode,
    told: toldSort,
  });

  if (!viewers.length) {
    return (
      <div className={styles.legend}>
        <Trans i18nKey="ai-insider-alerts.support.viewers-none">
          No viewer list for it yet: it is read after the problem is confirmed.
        </Trans>
      </div>
    );
  }
  return (
    <>
      <ColumnFilter filter={filter} rows={viewers} columns={columns} shown={filtered.length} />
      <div className={styles.tableWrap}>
        <table className={cx(styles.table, styles.innerTable)}>
          <thead>
            <tr>
              <SortHeader sort={sort} column="viewer">
                <Trans i18nKey="ai-insider-alerts.support.col-account">Account</Trans>
              </SortHeader>
              {withChannels && (
                <SortHeader sort={sort} column="channels">
                  <Trans i18nKey="ai-insider-alerts.viewers.col-channels">Channels with errors</Trans>
                </SortHeader>
              )}
              <SortHeader sort={sort} column="device">
                <Trans i18nKey="ai-insider-alerts.viewers.col-device">Platform · model</Trans>
              </SortHeader>
              <SortHeader sort={sort} column="os">
                <Trans i18nKey="ai-insider-alerts.viewers.col-os">OS</Trans>
              </SortHeader>
              <SortHeader sort={sort} column="app">
                <Trans i18nKey="ai-insider-alerts.viewers.col-app">App version</Trans>
              </SortHeader>
              <SortHeader sort={sort} column="network">
                <Trans i18nKey="ai-insider-alerts.viewers.col-network">Network · ISP</Trans>
              </SortHeader>
              <SortHeader sort={sort} column="ip">
                <Trans i18nKey="ai-insider-alerts.viewers.col-ip">IP</Trans>
              </SortHeader>
              <SortHeader sort={sort} column="ids">
                <Trans i18nKey="ai-insider-alerts.viewers.col-ids">Serial · device ID</Trans>
              </SortHeader>
              <SortHeader sort={sort} column="firstErr">
                {t('ai-insider-alerts.support.col-first-error', 'First error ({{tz}})', { tz: zoneLabel() })}
              </SortHeader>
              <SortHeader sort={sort} column="errors" className={styles.num}>
                <Trans i18nKey="ai-insider-alerts.support.col-errors">Errors</Trans>
              </SortHeader>
              <SortHeader sort={sort} column="error">
                <Trans i18nKey="ai-insider-alerts.viewers.col-error">Error</Trans>
              </SortHeader>
              <SortHeader sort={sort} column="told">
                <Trans i18nKey="ai-insider-alerts.support.col-told">Told</Trans>
              </SortHeader>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, VIEWERS_LIMIT).map((u) => (
              <tr key={u.userId}>
                <td className={cx(styles.mono, local.nowrap)}>
                  <ViewerId viewer={u} linkClassName={styles.link} onClick={() => onViewer(u.userId)} />
                </td>
                {withChannels && (
                  <td>
                    <ChannelsCell row={u} />
                  </td>
                )}
                <td>
                  <DeviceCell row={u} />
                </td>
                <td>{list(u.os)}</td>
                <td className={styles.mono}>{list(u.appVersions)}</td>
                <td>
                  <NetworkCell row={u} />
                </td>
                <td className={cx(styles.mono, local.nowrap)}>{list(u.ips)}</td>
                <td>
                  <IdsCell row={u} />
                </td>
                <td>{formatWhen(u.firstErr)}</td>
                <td className={styles.num}>{u.errEvents}</td>
                <td>
                  <ErrorCell code={u.topCode} platform={u.platform} dict={dict} />
                </td>
                <td>{told(u)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.length > VIEWERS_LIMIT && (
        <div className={styles.sub}>
          {t('ai-insider-alerts.support.more-viewers', '…and {{count}} more. Find any of them in Viewer lookup.', {
            count: formatCount(filtered.length - VIEWERS_LIMIT),
          })}
        </div>
      )}
    </>
  );
}

/** One looked-up viewer: every id and device seen on their errors in the period. */
export function ViewerProfile({
  userId,
  rows,
  customer,
}: {
  userId: string;
  rows: AffectedUserRow[];
  customer: CustomerSideRow[];
}) {
  const styles = useStyles2(getResultStyles);
  const local = useStyles2(getStyles);
  const all: Array<AffectedUserRow | CustomerSideRow> = [...rows, ...customer];
  const first = all[0];
  const kind = first ? viewerKindText({ userKind: first.userKind, platform: first.platform }) : undefined;
  const uniq = (values: string[]) => Array.from(new Set(values.filter(Boolean)));
  const facts: Array<{ label: string; values: string[]; mono?: boolean }> = [
    {
      label: t('ai-insider-alerts.viewers.fact-accounts', 'Account'),
      values: mergeDetail(all, 'accounts'),
      mono: true,
    },
    { label: t('ai-insider-alerts.viewers.fact-platforms', 'Platform'), values: uniq(all.map((r) => r.platform)) },
    { label: t('ai-insider-alerts.viewers.fact-models', 'Model'), values: mergeDetail(all, 'models') },
    { label: t('ai-insider-alerts.viewers.fact-os', 'OS'), values: mergeDetail(all, 'os') },
    {
      label: t('ai-insider-alerts.viewers.fact-app', 'App version'),
      values: mergeDetail(all, 'appVersions'),
      mono: true,
    },
    {
      label: t('ai-insider-alerts.viewers.fact-serials', 'Device serial'),
      values: mergeDetail(all, 'serials'),
      mono: true,
    },
    {
      label: t('ai-insider-alerts.viewers.fact-device-ids', 'Device ID'),
      values: mergeDetail(all, 'deviceIds'),
      mono: true,
    },
    { label: t('ai-insider-alerts.viewers.fact-ips', 'IP'), values: mergeDetail(all, 'ips'), mono: true },
    { label: t('ai-insider-alerts.viewers.fact-network', 'Network'), values: uniq(all.map((r) => r.network)) },
    {
      label: t('ai-insider-alerts.viewers.fact-isp', 'ISP · city'),
      values: uniq(all.map((r) => [r.isp, r.city].filter(Boolean).join(' · '))),
    },
  ];
  return (
    <div className={local.profile}>
      <div className={local.profileHead}>
        <span className={cx(styles.mono, local.account)}>{userId}</span>
        {kind && <span className={local.faint}>{kind}</span>}
      </div>
      <dl className={local.facts}>
        {facts.map((f) => (
          <div key={f.label} className={local.fact}>
            <dt>{f.label}</dt>
            <dd className={cx(f.mono && styles.mono)}>{f.values.length ? f.values.join(', ') : EMPTY}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The cohorts of a problem: share of its viewers per platform, model, build, OS, network and ISP. */
export interface Cohort {
  key: 'channel' | 'platform' | 'model' | 'app' | 'os' | 'network' | 'isp' | 'error';
  label: string;
  /** Most viewers first. */
  values: Array<{ value: string; viewers: number }>;
}

/** A cohort holding at least this share of at least COHORT_MIN viewers is called out. */
export const COHORT_CONCENTRATED = 0.8;
const COHORT_MIN = 5;
const COHORT_TOP = 4;

export function cohortsOf(viewers: AffectedUserRow[], dict?: ErrorDictionary): Cohort[] {
  const dims: Array<{ key: Cohort['key']; label: string; of: (u: AffectedUserRow) => string | string[] }> = [
    // A viewer of a wide problem counts on every channel they had errors on.
    {
      key: 'channel',
      label: t('ai-insider-alerts.cohort.channel', 'Channel'),
      of: (u) => channelValues(u.channelTitles),
    },
    { key: 'platform', label: t('ai-insider-alerts.cohort.platform', 'Platform'), of: (u) => u.platform },
    {
      key: 'model',
      label: t('ai-insider-alerts.cohort.model', 'Model'),
      of: (u) => detailValues(u.models)[0] ?? '',
    },
    {
      key: 'app',
      label: t('ai-insider-alerts.cohort.app', 'App version'),
      of: (u) => {
        const v = detailValues(u.appVersions)[0];
        return v ? `${u.platform} ${v}` : '';
      },
    },
    {
      key: 'os',
      label: t('ai-insider-alerts.cohort.os', 'OS'),
      of: (u) => {
        const v = detailValues(u.os)[0];
        return v ? `${u.platform} ${v}` : '';
      },
    },
    { key: 'network', label: t('ai-insider-alerts.cohort.network', 'Network'), of: (u) => u.network },
    { key: 'isp', label: t('ai-insider-alerts.cohort.isp', 'ISP'), of: (u) => u.isp },
    {
      key: 'error',
      label: t('ai-insider-alerts.cohort.error', 'Error'),
      of: (u) => {
        const description = describeError(dict, u.topCode, u.platform);
        return description ? `${errorKeyText(u.topCode)} — ${description}` : errorKeyText(u.topCode);
      },
    },
  ];
  // Channel problems have no channel per viewer: the channel is the problem.
  const withChannels = viewers.some((u) => u.channelTitles);
  return dims
    .filter((d) => withChannels || d.key !== 'channel')
    .map((d) => {
      const counts = new Map<string, number>();
      for (const u of viewers) {
        const of = d.of(u);
        const values = Array.isArray(of) ? of : [of];
        for (const v of values.length ? values : ['']) {
          counts.set(v || '—', (counts.get(v || '—') ?? 0) + 1);
        }
      }
      return {
        key: d.key,
        label: d.label,
        values: [...counts.entries()]
          .map(([value, n]) => ({ value, viewers: n }))
          .sort((a, b) => b.viewers - a.viewers),
      };
    });
}

/** The top value of a cohort when nearly every viewer of the problem shares it. */
export function concentrated(cohort: Cohort, total: number): { value: string; share: number } | undefined {
  const top = cohort.values[0];
  if (!top || top.value === '—' || total < COHORT_MIN) {
    return undefined;
  }
  const share = top.viewers / total;
  return share >= COHORT_CONCENTRATED ? { value: top.value, share } : undefined;
}

export function CohortBreakdown({ viewers }: { viewers: AffectedUserRow[] }) {
  const styles = useStyles2(getResultStyles);
  const local = useStyles2(getStyles);
  const dict = useErrorDictionary();
  const cohorts = useMemo(() => cohortsOf(viewers, dict), [viewers, dict]);
  if (!viewers.length) {
    return null;
  }
  const total = viewers.length;
  // Platform, network and error are said by the other blocks already; a skew
  // on build, model, OS or ISP is the news (a bad release, one ISP's network).
  const called = cohorts
    .filter((c) => c.key !== 'error')
    .map((c) => ({ cohort: c, top: concentrated(c, total) }))
    .filter((c) => c.top && c.cohort.values.length > 0);
  return (
    <div className={local.cohorts}>
      <div className={styles.detailLabel}>
        <Trans i18nKey="ai-insider-alerts.cohort.title">Who is hit</Trans>
      </div>
      {called.length > 0 && (
        <div className={local.called}>
          {called.map(({ cohort, top }) => (
            <span key={cohort.key} className={local.calledItem}>
              {t('ai-insider-alerts.cohort.mostly', '{{share}}% on {{what}} {{value}}', {
                share: Math.round(top!.share * 100),
                what: cohort.label.toLowerCase(),
                value: top!.value,
                interpolation: { escapeValue: false },
              })}
            </span>
          ))}
        </div>
      )}
      <div className={local.cohortGrid}>
        {cohorts.map((c) => (
          <div key={c.key}>
            <div className={local.faint}>{c.label}</div>
            {c.values.slice(0, COHORT_TOP).map((v) => (
              <div key={v.value} className={local.cohortRow}>
                <span className={local.cohortValue} title={v.value}>
                  {v.value}
                </span>
                <span className={local.cohortBar}>
                  <span style={{ width: `${Math.round((v.viewers / total) * 100)}%` }} />
                </span>
                <span className={local.cohortCount}>{formatCount(v.viewers)}</span>
              </div>
            ))}
            {c.values.length > COHORT_TOP && (
              <div className={local.faint}>
                {t('ai-insider-alerts.cohort.more', '+{{count}} more', { count: c.values.length - COHORT_TOP })}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  faint: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  nowrap: css({
    whiteSpace: 'nowrap',
    wordBreak: 'normal',
  }),
  ids: css({
    display: 'grid',
    gap: 2,
  }),
  profile: css({
    display: 'grid',
    gap: theme.spacing(1),
  }),
  profileHead: css({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: theme.spacing(1.5),
  }),
  account: css({
    fontSize: theme.typography.h4.fontSize,
  }),
  facts: css({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: theme.spacing(1, 2),
    margin: 0,
  }),
  fact: css({
    minWidth: 0,
    dt: {
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
      fontWeight: theme.typography.fontWeightRegular,
    },
    dd: {
      margin: 0,
      wordBreak: 'break-word',
    },
  }),
  cohorts: css({
    display: 'grid',
    gap: theme.spacing(1),
  }),
  called: css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(1),
  }),
  calledItem: css({
    padding: theme.spacing(0.25, 1),
    borderRadius: theme.shape.radius.pill,
    border: `1px solid ${theme.colors.warning.border}`,
    background: theme.colors.warning.transparent,
    color: theme.colors.warning.text,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  cohortGrid: css({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: theme.spacing(1.5, 2),
  }),
  cohortRow: css({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) 60px auto',
    alignItems: 'center',
    gap: theme.spacing(1),
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  cohortValue: css({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  cohortBar: css({
    height: 6,
    borderRadius: theme.shape.radius.pill,
    background: analytix.control,
    overflow: 'hidden',
    span: {
      display: 'block',
      height: '100%',
      background: theme.colors.error.main,
    },
  }),
  cohortCount: css({
    color: theme.colors.text.secondary,
    textAlign: 'right',
    minWidth: 24,
  }),
});
