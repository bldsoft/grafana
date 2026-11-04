// Analytix: the support view of AI Insider Alerts. Three questions for the
// support team on shift, in plain words: what is broken right now, what
// happened to the viewer on the phone, and which channels keep failing.
// Everything for tuning the rules stays in the "Advanced" view (AlertsResults).

import { css, cx } from '@emotion/css';
import { Fragment, useMemo, useState } from 'react';

import { GrafanaTheme2 } from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import { Alert, Badge, BadgeColor, Icon, Input, RadioButtonGroup, Tab, TabsBar, useStyles2 } from '@grafana/ui';

import {
  AlertsSnapshot,
  DeadTab,
  IncidentSparkline,
  OpsTab,
  ProviderDetails,
  ServiceDetails,
  Tile,
  getStyles as getResultStyles,
} from './AlertsResults';
import { CdnConfirmation } from './CdnCheck';
import { ColumnFilter, FilterColumn, useColumnFilter } from './ColumnFilter';
import { ErrorCell, ErrorCodeList } from './ErrorText';
import { ViewerId } from './ViewerId';
import { AffectedViewersTable, CohortBreakdown, ViewerProfile, viewerFilterColumns } from './ViewerTables';
import { AskInsiderButton } from './askInsider';
import { activityPrompt, channelPrompt, providerPrompt } from './askPrompts';
import { channelCdnTarget, channelChartFrame, providerCdnTarget, providerChartFrame } from './cdn';
import { topKey } from './engine';
import { useErrorDictionary } from './errorCodes';
import { breakdown, formatAt, formatCount, formatMinutes, formatUntil, formatWhen, zoneLabel } from './format';
import { useTableSort, SortHeader } from './sortableTable';
import { PROVIDER_BUCKET_SEC } from './sql';
import {
  MAX_VIEWER_MATCHES,
  Problem,
  ProblemKind,
  ViewerHit,
  ViewerRecord,
  buildProblems,
  buildViewerAliases,
  buildViewerIndex,
  detailValues,
  findViewers,
  isMajor,
  medianRecoveryMinutes,
  viewerTotals,
  visibleMessages,
} from './support';
import type { AffectedUserRow, Decision, DecisionKind } from './types';

type SupportTab = 'problems' | 'viewer' | 'summary';
type ProblemFilter = 'all' | 'ongoing' | 'major';

const PROBLEMS_LIMIT = 300;

export function problemBadge(kind: ProblemKind): { text: string; color: BadgeColor; tooltip: string } {
  switch (kind) {
    case 'channel':
      return {
        text: t('ai-insider-alerts.support.kind-channel', 'Channel down'),
        color: 'red',
        tooltip: t('ai-insider-alerts.support.kind-channel-tip', 'Most viewers of this channel get playback errors'),
      };
    case 'unstable':
      return {
        text: t('ai-insider-alerts.support.kind-unstable', 'Channel unstable'),
        color: 'purple',
        tooltip: t('ai-insider-alerts.support.kind-unstable-tip', 'The channel keeps failing and coming back'),
      };
    case 'chronic':
      return {
        text: t('ai-insider-alerts.support.kind-chronic', 'Down for hours'),
        color: 'darkgrey',
        tooltip: t(
          'ai-insider-alerts.support.kind-chronic-tip',
          'Nobody has watched it without errors for hours: broken at the source or no longer broadcast'
        ),
      };
    case 'provider':
      return {
        text: t('ai-insider-alerts.support.kind-provider', 'Errors across the provider'),
        color: 'red',
        tooltip: t(
          'ai-insider-alerts.support.kind-provider-tip',
          'Many channels of one provider fail at once: a data centre, a network or the middleware'
        ),
      };
    case 'service_down':
      return {
        text: t('ai-insider-alerts.support.kind-service', 'Service down'),
        color: 'red',
        tooltip: t(
          'ai-insider-alerts.support.kind-service-tip',
          'Viewers keep reopening the app and cannot watch: login, middleware or the provider API'
        ),
      };
    case 'outage':
      return {
        text: t('ai-insider-alerts.support.kind-outage', 'Outage, several providers'),
        color: 'purple',
        tooltip: t(
          'ai-insider-alerts.support.kind-outage-tip',
          'Many providers abnormal at once: a data centre or a network'
        ),
      };
    default:
      return {
        text: t('ai-insider-alerts.support.kind-no-data', 'No data'),
        color: 'darkgrey',
        tooltip: t(
          'ai-insider-alerts.support.kind-no-data-tip',
          'Analytics stopped receiving events from several providers: nothing can be judged meanwhile'
        ),
      };
  }
}

/** What the viewer sees, in support's words. */
export function messageBadge(kind: DecisionKind): { text: string; color: BadgeColor; tooltip: string } {
  switch (kind) {
    case 'down':
      return {
        text: t('ai-insider-alerts.support.msg-down', 'Push: channel down'),
        color: 'red',
        tooltip: t('ai-insider-alerts.support.msg-down-tip', 'A push: the channel is down and we are on it'),
      };
    case 'service':
      return {
        text: t('ai-insider-alerts.support.msg-service', 'Push: service problems'),
        color: 'red',
        tooltip: t('ai-insider-alerts.support.msg-service-tip', 'A push: the service has problems and we are on it'),
      };
    case 'unstable':
      return {
        text: t('ai-insider-alerts.support.msg-unstable', 'Push: channel unstable'),
        color: 'purple',
        tooltip: t(
          'ai-insider-alerts.support.msg-unstable-tip',
          'A push: the channel keeps failing, we will tell when it is stable'
        ),
      };
    case 'in_app':
      return {
        text: t('ai-insider-alerts.support.msg-in-app', 'Message in player'),
        color: 'orange',
        tooltip: t(
          'ai-insider-alerts.support.msg-in-app-tip',
          'No push: a short failure, the player shows a message if they retry'
        ),
      };
    case 'back':
      return {
        text: t('ai-insider-alerts.support.msg-back', 'Push: it is back'),
        color: 'green',
        tooltip: t('ai-insider-alerts.support.msg-back-tip', 'A push: the channel works again'),
      };
    case 'apology':
      return {
        text: t('ai-insider-alerts.support.msg-apology', 'Push: back, with apology'),
        color: 'green',
        tooltip: t(
          'ai-insider-alerts.support.msg-apology-tip',
          'A push: it works again, sorry for the outage (they were watching before it)'
        ),
      };
    case 'suppressed':
      return {
        text: t('ai-insider-alerts.support.msg-none', 'Not messaged'),
        color: 'darkgrey',
        tooltip: t(
          'ai-insider-alerts.support.msg-none-tip',
          'Already told about this channel recently, or too few errors to bother them'
        ),
      };
    default:
      return {
        text: t('ai-insider-alerts.support.msg-diagnosis', 'Their side'),
        color: 'blue',
        tooltip: t(
          'ai-insider-alerts.support.msg-diagnosis-tip',
          'A personal message: channels that work for everyone else fail for them, likely their network or device'
        ),
      };
  }
}

function problemTitle(p: Problem): string {
  if (p.kind === 'outage' || p.kind === 'no_data') {
    return t('ai-insider-alerts.support.providers-count', '{{count}} providers', {
      count: Object.keys(p.activity?.pids ?? {}).length,
    });
  }
  return p.title;
}

function problemSub(p: Problem): string {
  if (p.kind === 'outage' || p.kind === 'no_data') {
    const pids = Object.entries(p.activity?.pids ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([pid]) => pid);
    return [...pids.slice(0, 8), ...(pids.length > 8 ? ['…'] : [])].join(', ');
  }
  if (p.source === 'channel') {
    return p.provider ? `${p.pid} ${p.provider}` : p.pid;
  }
  // The title already names the provider; show its id.
  return p.provider ? p.pid : '';
}

function StatusBadge({ problem }: { problem: Problem }) {
  if (problem.ongoing) {
    return <Badge text={t('ai-insider-alerts.support.status-ongoing', 'Ongoing')} color="red" icon="fire" />;
  }
  if (problem.recovered === false) {
    return (
      <Badge
        text={t('ai-insider-alerts.support.status-ended', 'Ended')}
        color="darkgrey"
        tooltip={t(
          'ai-insider-alerts.support.status-ended-tip',
          'Errors stopped, but nobody watched afterwards, so recovery is not confirmed'
        )}
      />
    );
  }
  return <Badge text={t('ai-insider-alerts.support.status-back', 'Back')} color="green" icon="check" />;
}

function MessageChain({ messages, ongoing }: { messages: Decision[]; ongoing?: boolean }) {
  const styles = useStyles2(getStyles);
  if (!messages.length) {
    return (
      <span className={styles.faint}>
        {ongoing ? (
          <Trans i18nKey="ai-insider-alerts.support.no-message-yet">nothing yet</Trans>
        ) : (
          <Trans i18nKey="ai-insider-alerts.support.no-message">
            nothing: errors ended before the problem was confirmed
          </Trans>
        )}
      </span>
    );
  }
  return (
    <div className={styles.chain}>
      {messages.map((m, i) => {
        const badge = messageBadge(m.kind);
        return (
          <span key={`${m.kind}-${m.at}-${i}`} className={styles.chainItem}>
            <span className={styles.faint}>{formatWhen(m.at)}</span>
            <Badge text={badge.text} color={badge.color} tooltip={badge.tooltip} />
          </span>
        );
      })}
    </div>
  );
}

export function SupportResults({ snapshot }: { snapshot: AlertsSnapshot }) {
  const styles = useStyles2(getResultStyles);
  const local = useStyles2(getStyles);
  const [tab, setTab] = useState<SupportTab>('problems');
  const [expanded, setExpanded] = useState<string>();
  const [viewerQuery, setViewerQuery] = useState('');
  const [filter, setFilter] = useState<ProblemFilter>('all');
  const [search, setSearch] = useState('');

  const problems = useMemo(() => buildProblems(snapshot), [snapshot]);
  const viewers = useMemo(() => buildViewerIndex(snapshot, problems), [snapshot, problems]);
  const aliases = useMemo(() => buildViewerAliases(viewers), [viewers]);
  const totals = useMemo(() => viewerTotals(viewers), [viewers]);

  const ongoing = problems.filter((p) => p.ongoing && p.kind !== 'chronic');
  const majorOngoing = ongoing.filter(isMajor);
  const chronic = problems.filter((p) => p.ongoing && p.kind === 'chronic').length;
  const recovered = problems.filter((p) => !p.ongoing).length;
  const median = medianRecoveryMinutes(problems);
  const summaryRows = snapshot.channels.filter((r) => r.days >= 2 || r.unstableIncidents > 0 || r.offAir > 0 || r.dead);

  const openViewer = (userId: string) => {
    setViewerQuery(userId);
    setTab('viewer');
  };
  const openProblem = (id: string) => {
    setTab('problems');
    // Whatever the list was narrowed to, the problem opened must be in it.
    setSearch('');
    setFilter((f) =>
      f === 'all' || problems.find((p) => p.id === id && (f === 'ongoing' ? p.ongoing : isMajor(p))) ? f : 'all'
    );
    setExpanded(id);
    requestAnimationFrame(() => document.getElementById(`ai-support-${id}`)?.scrollIntoView({ block: 'center' }));
  };

  return (
    <div className={styles.results}>
      {majorOngoing.length > 0 && <MajorProblems problems={majorOngoing} to={snapshot.to} onOpen={openProblem} />}
      <div className={styles.tiles}>
        <Tile
          alert={ongoing.length > 0}
          label={t('ai-insider-alerts.support.tile-ongoing', 'Ongoing problems')}
          value={formatCount(ongoing.length)}
          detail={
            chronic
              ? t(
                  'ai-insider-alerts.support.tile-ongoing-chronic',
                  'as of {{clock}} {{tz}} · and {{chronic}} channels down for hours',
                  {
                    tz: zoneLabel(),
                    clock: formatAt(snapshot.to),
                    chronic,
                  }
                )
              : t('ai-insider-alerts.support.tile-ongoing-detail', 'as of {{clock}} {{tz}}', {
                  tz: zoneLabel(),
                  clock: formatAt(snapshot.to),
                })
          }
        />
        <Tile
          label={t('ai-insider-alerts.support.tile-viewers', 'Viewers hit')}
          value={formatCount(totals.hit)}
          detail={t('ai-insider-alerts.support.tile-viewers-detail', '{{told}} of them got a message', {
            told: formatCount(totals.told),
          })}
        />
        <Tile
          label={t('ai-insider-alerts.support.tile-resolved', 'Resolved')}
          value={formatCount(recovered)}
          detail={
            median === undefined
              ? t('ai-insider-alerts.support.tile-resolved-none', 'since {{from}} {{tz}}', {
                  tz: zoneLabel(),
                  from: formatAt(snapshot.from),
                })
              : t('ai-insider-alerts.support.tile-resolved-detail', 'typically back in {{minutes}} min', {
                  minutes: Math.round(median),
                })
          }
        />
      </div>

      <div className={styles.tabsRow}>
        <TabsBar className={styles.tabs}>
          <Tab
            label={t('ai-insider-alerts.support.tab-problems', 'Problems')}
            counter={problems.length}
            active={tab === 'problems'}
            onChangeTab={() => setTab('problems')}
          />
          <Tab
            label={t('ai-insider-alerts.support.tab-viewer', 'Viewer lookup')}
            icon="search"
            active={tab === 'viewer'}
            onChangeTab={() => setTab('viewer')}
          />
          <Tab
            label={t('ai-insider-alerts.support.tab-summary', 'Channels to watch')}
            counter={summaryRows.length + snapshot.dead.length}
            active={tab === 'summary'}
            onChangeTab={() => setTab('summary')}
          />
        </TabsBar>
      </div>

      <div className={styles.tabBody}>
        {tab === 'problems' && (
          <ProblemsTab
            problems={problems}
            snapshot={snapshot}
            filter={filter}
            onFilter={setFilter}
            search={search}
            onSearch={setSearch}
            expanded={expanded}
            onToggle={setExpanded}
            onViewer={openViewer}
          />
        )}
        {tab === 'viewer' && (
          <ViewerTab
            index={viewers}
            aliases={aliases}
            query={viewerQuery}
            onQuery={setViewerQuery}
            from={snapshot.from}
            to={snapshot.to}
            onProblem={openProblem}
          />
        )}
        {tab === 'summary' && (
          <>
            <h4 className={local.sectionTitle}>
              <Trans i18nKey="ai-insider-alerts.support.summary-recurring">Channels that keep failing</Trans>
            </h4>
            {summaryRows.length ? (
              <OpsTab rows={summaryRows} />
            ) : (
              <p className={styles.empty}>
                <Trans i18nKey="ai-insider-alerts.support.summary-none">
                  No channel failed on several days, kept flapping or looked off the air.
                </Trans>
              </p>
            )}
            <h4 className={local.sectionTitle}>
              <Trans i18nKey="ai-insider-alerts.support.summary-dead">Channels not working at all</Trans>
            </h4>
            <DeadTab rows={snapshot.dead} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Ongoing problems wider than one channel, pinned above everything: a
 * provider, the service or several providers down must not drown among the
 * channel failures in the list below.
 */
function MajorProblems({ problems, to, onOpen }: { problems: Problem[]; to: number; onOpen: (id: string) => void }) {
  const local = useStyles2(getStyles);
  return (
    <section
      className={local.major}
      aria-label={t('ai-insider-alerts.support.major-label', 'Ongoing problems wider than one channel')}
    >
      <div className={local.majorTitle}>
        <Icon name="fire" />
        {t('ai-insider-alerts.support.major-title', 'Wide problems now: {{count}}', { count: problems.length })}
      </div>
      {problems.map((p) => {
        const badge = problemBadge(p.kind);
        const sub = problemSub(p);
        return (
          <button key={p.id} type="button" className={local.majorRow} onClick={() => onOpen(p.id)}>
            <Badge text={badge.text} color={badge.color} tooltip={badge.tooltip} />
            <strong>{problemTitle(p)}</strong>
            {sub && <span className={local.faint}>{sub}</span>}
            <span className={local.majorSince}>
              {t('ai-insider-alerts.support.major-since', 'since {{time}} · {{duration}}', {
                time: formatAt(p.start),
                duration: formatMinutes(p.start, to),
              })}
              {p.source !== 'activity' &&
                ` · ${t('ai-insider-alerts.support.major-viewers', '{{count}} viewers hit', { count: p.viewers })}`}
            </span>
          </button>
        );
      })}
    </section>
  );
}

function ProblemsTab({
  problems,
  snapshot,
  filter,
  onFilter: setFilter,
  search,
  onSearch: setSearch,
  expanded,
  onToggle,
  onViewer,
}: {
  problems: Problem[];
  snapshot: AlertsSnapshot;
  filter: ProblemFilter;
  onFilter: (filter: ProblemFilter) => void;
  search: string;
  onSearch: (search: string) => void;
  expanded?: string;
  onToggle: (id?: string) => void;
  onViewer: (userId: string) => void;
}) {
  const styles = useStyles2(getResultStyles);
  const local = useStyles2(getStyles);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return problems.filter(
      (p) =>
        (filter === 'all' || (filter === 'ongoing' ? p.ongoing : isMajor(p))) &&
        (!q || `${problemTitle(p)} ${p.pid} ${p.provider} ${problemBadge(p.kind).text}`.toLowerCase().includes(q))
    );
  }, [problems, filter, search]);
  const ongoingCount = problems.filter((p) => p.ongoing).length;
  const majorCount = problems.filter(isMajor).length;

  if (!problems.length) {
    return (
      <p className={styles.empty}>
        <Trans i18nKey="ai-insider-alerts.support.no-problems">
          No problems found: channels, providers and the service work as usual.
        </Trans>
      </p>
    );
  }

  const filterOptions = [
    {
      label: t('ai-insider-alerts.support.filter-all', 'All ({{count}})', { count: problems.length }),
      value: 'all' as const,
    },
    {
      label: t('ai-insider-alerts.support.filter-ongoing', 'Ongoing ({{count}})', { count: ongoingCount }),
      value: 'ongoing' as const,
    },
    {
      label: t('ai-insider-alerts.support.filter-major', 'Wide ({{count}})', { count: majorCount }),
      value: 'major' as const,
      description: t(
        'ai-insider-alerts.support.filter-major-tip',
        'Problems wider than one channel: a provider, the service, several providers'
      ),
    },
  ];

  return (
    <>
      <div className={styles.toolbar}>
        <RadioButtonGroup size="sm" options={filterOptions} value={filter} onChange={setFilter} />
        <Input
          className={styles.search}
          prefix={<Icon name="search" />}
          placeholder={t('ai-insider-alerts.support.problems-search', 'Channel or provider')}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>
                <Trans i18nKey="ai-insider-alerts.support.col-status">Status</Trans>
              </th>
              <th>
                <Trans i18nKey="ai-insider-alerts.support.col-problem">Problem</Trans>
              </th>
              <th>{t('ai-insider-alerts.support.col-started', 'Started ({{tz}})', { tz: zoneLabel() })}</th>
              <th>
                <Trans i18nKey="ai-insider-alerts.support.col-duration">Duration</Trans>
              </th>
              <th className={styles.num}>
                <Trans i18nKey="ai-insider-alerts.support.col-viewers">Viewers hit</Trans>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, PROBLEMS_LIMIT).map((p) => {
              const open = expanded === p.id;
              const badge = problemBadge(p.kind);
              const sub = problemSub(p);
              return (
                <Fragment key={p.id}>
                  <tr
                    id={`ai-support-${p.id}`}
                    className={cx(
                      styles.clickable,
                      open && styles.rowOpen,
                      p.ongoing && local.ongoingRow,
                      p.ongoing && isMajor(p) && local.majorRowTable
                    )}
                    onClick={() => onToggle(open ? undefined : p.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onToggle(open ? undefined : p.id);
                      }
                    }}
                    tabIndex={0}
                    aria-expanded={open}
                  >
                    <td>
                      <StatusBadge problem={p} />
                    </td>
                    <td>
                      <div className={local.problemCell}>
                        <Badge text={badge.text} color={badge.color} tooltip={badge.tooltip} />
                        <strong>{problemTitle(p)}</strong>
                      </div>
                      {sub && <span className={styles.sub}>{sub}</span>}
                    </td>
                    <td>{formatAt(p.start)}</td>
                    <td>
                      {formatMinutes(p.start, p.closedAt ?? snapshot.to)}
                      {p.closedAt !== undefined && (
                        <span className={styles.sub}>
                          {p.recovered === false
                            ? t('ai-insider-alerts.support.ended-at', 'errors stopped {{time}}', {
                                time: formatUntil(p.start, p.closedAt),
                              })
                            : t('ai-insider-alerts.support.back-at', 'back at {{time}}', {
                                time: formatUntil(p.start, p.closedAt),
                              })}
                        </span>
                      )}
                    </td>
                    <td className={styles.num}>
                      {p.source === 'activity' ? (
                        <>—</>
                      ) : (
                        <>
                          {formatCount(p.viewers)}
                          <span className={styles.sub}>
                            {t('ai-insider-alerts.support.told', '{{count}} told', { count: p.told })}
                          </span>
                        </>
                      )}
                    </td>
                  </tr>
                  {open && (
                    <tr className={styles.detailRow}>
                      <td colSpan={5}>
                        <ProblemDetails problem={p} snapshot={snapshot} onViewer={onViewer} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {filtered.length > PROBLEMS_LIMIT && (
        <div className={styles.legend}>
          {t('ai-insider-alerts.support.problems-truncated', 'Showing the first {{shown}} of {{total}}.', {
            shown: PROBLEMS_LIMIT,
            total: formatCount(filtered.length),
          })}
        </div>
      )}
    </>
  );
}

function ProblemDetails({
  problem,
  snapshot,
  onViewer,
}: {
  problem: Problem;
  snapshot: AlertsSnapshot;
  onViewer: (userId: string) => void;
}) {
  const styles = useStyles2(getResultStyles);

  const { activity, channel, providerIncident } = problem;
  const ask = (
    <AskInsiderButton
      source={`support-${problem.source}`}
      prompt={() =>
        activity ? activityPrompt(activity) : channel ? channelPrompt(channel) : providerPrompt(providerIncident!)
      }
    />
  );

  if (activity) {
    return (
      <div className={styles.details}>
        {ask}
        <ServiceDetails incident={activity} />
        <div className={styles.legend}>
          <Trans i18nKey="ai-insider-alerts.support.activity-note">
            A signal for the operations team. Viewers are not messaged about it one by one: channel and provider
            problems at the same time carry the messages.
          </Trans>
        </div>
      </div>
    );
  }

  const viewers = problem.channel ? snapshot.affected(problem.id) : snapshot.providerAffected(problem.id);
  const messages = snapshot.decisions.filter((d) => d.incidentId === problem.id);
  // One time axis for the analytics chart and the CDN chart below it.
  const frame = problem.channel
    ? channelChartFrame(problem.channel, snapshot.to)
    : problem.providerIncident && providerChartFrame(problem.providerIncident, PROVIDER_BUCKET_SEC, snapshot.to);
  return (
    <div className={styles.details}>
      {ask}
      {problem.channel && (
        <IncidentSparkline
          incident={problem.channel}
          cls={snapshot.classOf(problem.channel)}
          to={snapshot.to}
          frame={frame}
        />
      )}
      {problem.providerIncident && <ProviderDetails incident={problem.providerIncident} frame={frame} />}
      <CdnConfirmation
        frame={frame}
        target={
          problem.channel
            ? channelCdnTarget(problem.channel, snapshot.to)
            : problem.providerIncident && providerCdnTarget(problem.providerIncident, PROVIDER_BUCKET_SEC, snapshot.to)
        }
      />
      <div className={styles.detailGrid}>
        <div>
          <div className={styles.detailLabel}>
            <Trans i18nKey="ai-insider-alerts.support.detail-told">What viewers were told</Trans>
          </div>
          <MessageCounts messages={messages} />
        </div>
        {problem.channel && (
          <div>
            <div className={styles.detailLabel}>
              <Trans i18nKey="ai-insider-alerts.support.detail-where">For the operations team</Trans>
            </div>
            <span className={styles.mono}>{topKey(problem.channel.paths) || topKey(problem.channel.hosts) || '—'}</span>
            <div className={styles.sub}>{breakdown(problem.channel.platforms, 3)}</div>
            <div className={styles.sub}>
              <ErrorCodeList codes={problem.channel.codes} platforms={problem.channel.platforms} limit={3} />
            </div>
          </div>
        )}
        {problem.providerIncident && (
          <div>
            <div className={styles.detailLabel}>
              <Trans i18nKey="ai-insider-alerts.support.detail-where">For the operations team</Trans>
            </div>
            <div>{breakdown(problem.providerIncident.platforms, 3)}</div>
            <div className={styles.sub}>
              <ErrorCodeList
                codes={problem.providerIncident.codes}
                platforms={problem.providerIncident.platforms}
                limit={3}
              />
            </div>
          </div>
        )}
      </div>
      <CohortBreakdown viewers={viewers} />
      <AffectedViewers viewers={viewers} messages={messages} ongoing={problem.ongoing} onViewer={onViewer} />
    </div>
  );
}

function MessageCounts({ messages }: { messages: Decision[] }) {
  const styles = useStyles2(getStyles);
  const counts = new Map<DecisionKind, Set<string>>();
  const sentTo = new Set(messages.filter((m) => m.kind !== 'suppressed').map((m) => m.userId));
  for (const m of messages) {
    // Held back counts only viewers who got nothing else about it.
    if (m.kind === 'suppressed' && sentTo.has(m.userId)) {
      continue;
    }
    const set = counts.get(m.kind) ?? new Set<string>();
    set.add(m.userId);
    counts.set(m.kind, set);
  }
  if (!counts.size) {
    return (
      <span className={styles.faint}>
        <Trans i18nKey="ai-insider-alerts.support.nobody-told">Nobody yet</Trans>
      </span>
    );
  }
  return (
    <div className={styles.chain}>
      {[...counts.entries()].map(([kind, users]) => {
        const badge = messageBadge(kind);
        return (
          <span key={kind} className={styles.chainItem}>
            <Badge text={badge.text} color={badge.color} tooltip={badge.tooltip} />
            <span>{formatCount(users.size)}</span>
          </span>
        );
      })}
    </div>
  );
}

function AffectedViewers({
  viewers,
  messages,
  ongoing,
  onViewer,
}: {
  viewers: AffectedUserRow[];
  messages: Decision[];
  ongoing: boolean;
  onViewer: (userId: string) => void;
}) {
  const byUser = useMemo(() => {
    const map = new Map<string, Decision[]>();
    for (const m of messages) {
      map.set(m.userId, [...(map.get(m.userId) ?? []), m]);
    }
    return map;
  }, [messages]);
  const shown = (u: AffectedUserRow) => visibleMessages(byUser.get(u.userId) ?? []);
  return (
    <AffectedViewersTable
      viewers={viewers}
      onViewer={onViewer}
      told={(u) => <MessageChain messages={shown(u)} ongoing={ongoing} />}
      toldSort={(u) =>
        shown(u)
          .map((m) => messageBadge(m.kind).text)
          .join(' ') || undefined
      }
    />
  );
}

function ViewerTab({
  index,
  aliases,
  query,
  onQuery,
  from,
  to,
  onProblem,
}: {
  index: Map<string, ViewerRecord>;
  aliases: Map<string, ViewerRecord[]>;
  query: string;
  onQuery: (query: string) => void;
  from: number;
  to: number;
  onProblem: (id: string) => void;
}) {
  const styles = useStyles2(getResultStyles);
  const local = useStyles2(getStyles);
  const found = useMemo(() => findViewers(index, query, aliases), [index, query, aliases]);

  return (
    <>
      <div className={styles.toolbar}>
        <Input
          className={local.viewerSearch}
          prefix={<Icon name="search" />}
          placeholder={t(
            'ai-insider-alerts.support.viewer-placeholder',
            'Account number, device serial, device ID or IP'
          )}
          value={query}
          onChange={(e) => onQuery(e.currentTarget.value)}
          autoFocus
        />
      </div>
      {!query.trim() ? (
        <p className={styles.empty}>
          <Trans i18nKey="ai-insider-alerts.support.viewer-hint">
            Type the account of the viewer who contacted you, or the serial, device ID or IP of their device: you will
            see their devices and app versions, which problems they ran into in this period, the errors, what they were
            told, and whether the cause is likely on their side.
          </Trans>
        </p>
      ) : found.exact ? (
        <ViewerCard record={found.exact} from={from} to={to} onProblem={onProblem} />
      ) : found.total ? (
        <div className={local.matches}>
          <div className={styles.legend}>
            {found.total > MAX_VIEWER_MATCHES
              ? t(
                  'ai-insider-alerts.support.viewer-many',
                  '{{total}} accounts match, showing {{shown}}. Type more of it.',
                  {
                    total: formatCount(found.total),
                    shown: MAX_VIEWER_MATCHES,
                  }
                )
              : t('ai-insider-alerts.support.viewer-pick', '{{total}} accounts match:', { total: found.total })}
          </div>
          <div className={local.matchList}>
            {found.matches.map((r) => (
              <span key={r.userId} className={styles.mono}>
                <ViewerId viewer={recordIdentity(r)} linkClassName={styles.link} onClick={() => onQuery(r.userId)} />
              </span>
            ))}
          </div>
        </div>
      ) : (
        <ViewerVerdicts record={undefined} account={query.trim()} from={from} to={to} />
      )}
    </>
  );
}

/** The kind of a looked-up viewer id, from any row that carries it. */
function recordIdentity(record: ViewerRecord) {
  const row = record.hits[0]?.row ?? record.customer[0] ?? record.diagnoses[0];
  return { userId: record.userId, userKind: row?.userKind, platform: row?.platform };
}

function ViewerVerdicts({
  record,
  account,
  from,
  to,
}: {
  record?: ViewerRecord;
  account: string;
  from: number;
  to: number;
}) {
  const ongoing = record?.hits.filter((h) => h.problem.ongoing) ?? [];
  const customer = record?.customer ?? [];
  const past = (record?.hits.length ?? 0) - ongoing.length;
  const verdicts = [];

  if (ongoing.length) {
    const first = ongoing[0].problem;
    verdicts.push(
      <Alert
        key="ongoing"
        severity="error"
        title={t('ai-insider-alerts.support.verdict-ongoing', 'Affected by an ongoing problem')}
      >
        {t(
          'ai-insider-alerts.support.verdict-ongoing-body',
          '{{kind}}: {{what}}, since {{since}} {{tz}}. The cause is on our side, not with the viewer or their device.',
          {
            tz: zoneLabel(),
            kind: problemBadge(first.kind).text,
            what: problemTitle(first),
            since: formatAt(first.start),
            interpolation: { escapeValue: false },
          }
        )}
      </Alert>
    );
  }
  if (customer.length) {
    const c = customer[0];
    verdicts.push(
      <Alert
        key="customer"
        severity="warning"
        title={t('ai-insider-alerts.support.verdict-customer', 'Likely on the viewer’s side')}
      >
        {t(
          'ai-insider-alerts.support.verdict-customer-body',
          'Errors on {{channels}} channels that worked for everyone else at the same time ({{from}} – {{to}} {{tz}}, {{platform}}, {{where}}). Suggest restarting the device and checking the home network.',
          {
            tz: zoneLabel(),
            channels: c.channels,
            from: formatAt(c.firstMinute),
            to: formatUntil(c.firstMinute, c.lastMinute + 60),
            platform: [c.platform, c.network].filter(Boolean).join(' · ') || '—',
            where: [c.isp, c.city].filter(Boolean).join(', ') || '—',
            interpolation: { escapeValue: false },
          }
        )}
      </Alert>
    );
  }
  if (!ongoing.length && past > 0) {
    verdicts.push(
      <Alert key="past" severity="info" title={t('ai-insider-alerts.support.verdict-past', 'All resolved')}>
        {t(
          'ai-insider-alerts.support.verdict-past-body',
          'Problems they ran into in this period: {{count}}. Everything works again; details below.',
          { count: past }
        )}
      </Alert>
    );
  }
  if (!verdicts.length) {
    verdicts.push(
      <Alert
        key="none"
        severity="success"
        title={t('ai-insider-alerts.support.verdict-none', 'No problems found for {{account}}', {
          account,
          interpolation: { escapeValue: false },
        })}
      >
        {t(
          'ai-insider-alerts.support.verdict-none-body',
          'Between {{from}} and {{to}} {{tz}} this account was not hit by any outage. Single errors outside an outage are not listed here; check the account in the CRM, or run a longer period.',
          {
            tz: zoneLabel(),
            from: formatAt(from),
            to: formatAt(to),
          }
        )}
      </Alert>
    );
  }
  return <>{verdicts}</>;
}

function ViewerCard({
  record,
  from,
  to,
  onProblem,
}: {
  record: ViewerRecord;
  from: number;
  to: number;
  onProblem: (id: string) => void;
}) {
  const styles = useStyles2(getResultStyles);
  const local = useStyles2(getStyles);
  const dict = useErrorDictionary();
  const columns = useMemo(
    (): Array<FilterColumn<ViewerHit>> => [
      {
        key: 'problem',
        label: t('ai-insider-alerts.filter.col-problem', 'Problem'),
        values: (h) => [problemTitle(h.problem)],
        hint: (_, h) => problemSub(h.problem),
      },
      {
        key: 'kind',
        label: t('ai-insider-alerts.filter.col-kind', 'Kind'),
        values: (h) => [problemBadge(h.problem.kind).text],
      },
      ...viewerFilterColumns((h: ViewerHit) => h.row, dict).filter((c) => c.key !== 'account'),
    ],
    [dict]
  );
  const { filter, rows: hits } = useColumnFilter(record.hits, columns);
  const { rows, sort } = useTableSort(hits, {
    firstErr: (h) => h.row.firstErr,
    problem: (h) => problemTitle(h.problem),
    status: (h) => (h.problem.ongoing ? 0 : h.problem.recovered === false ? 1 : 2),
    device: (h) => `${h.row.platform} ${h.row.models ?? ''}`,
    app: (h) => h.row.appVersions,
    network: (h) => `${h.row.network} ${h.row.isp}`,
    ip: (h) => h.row.ips,
    errors: (h) => h.row.errEvents,
    error: (h) => h.row.topCode,
    told: (h) => h.messages.map((m) => messageBadge(m.kind).text).join(' ') || undefined,
  });

  return (
    <div className={styles.details}>
      <ViewerProfile userId={record.userId} rows={record.hits.map((h) => h.row)} customer={record.customer} />
      <ViewerVerdicts record={record} account={record.userId} from={from} to={to} />
      {record.hits.length > 0 && (
        <>
          <ColumnFilter filter={filter} rows={record.hits} columns={columns} shown={hits.length} />
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <SortHeader sort={sort} column="firstErr">
                    {t('ai-insider-alerts.support.col-first-error', 'First error ({{tz}})', { tz: zoneLabel() })}
                  </SortHeader>
                  <SortHeader sort={sort} column="problem">
                    <Trans i18nKey="ai-insider-alerts.support.col-problem">Problem</Trans>
                  </SortHeader>
                  <SortHeader sort={sort} column="status">
                    <Trans i18nKey="ai-insider-alerts.support.col-status">Status</Trans>
                  </SortHeader>
                  <SortHeader sort={sort} column="device">
                    <Trans i18nKey="ai-insider-alerts.viewers.col-device-os">Device · OS</Trans>
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
                {rows.map((h) => {
                  const badge = problemBadge(h.problem.kind);
                  return (
                    <tr key={h.problem.id}>
                      <td>{formatAt(h.row.firstErr)}</td>
                      <td>
                        <div className={local.problemCell}>
                          <Badge text={badge.text} color={badge.color} tooltip={badge.tooltip} />
                          <button type="button" className={styles.link} onClick={() => onProblem(h.problem.id)}>
                            {problemTitle(h.problem)}
                          </button>
                        </div>
                        <span className={styles.sub}>{problemSub(h.problem)}</span>
                      </td>
                      <td>
                        <StatusBadge problem={h.problem} />
                      </td>
                      <td>
                        {[h.row.platform, detailValues(h.row.models).join(', ')].filter(Boolean).join(' · ') || '—'}
                        <span className={styles.sub}>{detailValues(h.row.os).join(', ') || '—'}</span>
                      </td>
                      <td className={styles.mono}>{detailValues(h.row.appVersions).join(', ') || '—'}</td>
                      <td>
                        {h.row.network || '—'}
                        <span className={styles.sub}>{[h.row.isp, h.row.city].filter(Boolean).join(' · ') || '—'}</span>
                      </td>
                      <td className={cx(styles.mono, local.nowrap)}>{detailValues(h.row.ips).join(', ') || '—'}</td>
                      <td className={styles.num}>{h.row.errEvents}</td>
                      <td>
                        <ErrorCell code={h.row.topCode} platform={h.row.platform} dict={dict} />
                      </td>
                      <td>
                        <MessageChain messages={h.messages} ongoing={h.problem.ongoing} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {record.diagnoses.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t('ai-insider-alerts.support.col-when', 'When ({{tz}})', { tz: zoneLabel() })}</th>
                <th>
                  <Trans i18nKey="ai-insider-alerts.support.col-problem">Problem</Trans>
                </th>
                <th>
                  <Trans i18nKey="ai-insider-alerts.support.col-told">Told</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {record.diagnoses.map((d, i) => (
                <tr key={`diag-${d.at}-${i}`}>
                  <td>{formatAt(d.at)}</td>
                  <td>
                    <Trans i18nKey="ai-insider-alerts.support.their-side">Errors only on their side</Trans>
                    <span className={styles.sub}>{d.provider ? `${d.pid} ${d.provider}` : d.pid}</span>
                  </td>
                  <td>
                    <MessageChain messages={[d]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  major: css({
    display: 'grid',
    gap: theme.spacing(0.5),
    padding: theme.spacing(1.5),
    borderRadius: theme.shape.radius.default,
    border: `1px solid ${theme.colors.error.border}`,
    background: theme.colors.error.transparent,
  }),
  majorTitle: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    color: theme.colors.error.text,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  majorRow: css({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.spacing(1),
    padding: theme.spacing(0.5, 1),
    border: 'none',
    borderRadius: theme.shape.radius.default,
    background: 'transparent',
    color: theme.colors.text.primary,
    textAlign: 'left',
    cursor: 'pointer',
    '&:hover': {
      background: theme.colors.action.hover,
    },
  }),
  majorSince: css({
    marginLeft: 'auto',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  majorRowTable: css({
    td: {
      background: theme.colors.error.transparent,
    },
  }),
  ongoingRow: css({
    td: {
      boxShadow: `inset 3px 0 0 ${theme.colors.error.main}`,
    },
    'td ~ td': {
      boxShadow: 'none',
    },
  }),
  problemCell: css({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.spacing(1),
  }),
  chain: css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(0.5, 1.5),
  }),
  chainItem: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
  }),
  faint: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  viewerSearch: css({
    width: 360,
    maxWidth: '100%',
  }),
  matches: css({
    display: 'grid',
    gap: theme.spacing(1),
  }),
  matchList: css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(1, 2),
  }),
  viewerHead: css({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: theme.spacing(1.5),
  }),
  account: css({
    fontSize: theme.typography.h4.fontSize,
  }),
  nowrap: css({
    whiteSpace: 'nowrap',
    wordBreak: 'normal',
  }),
  sectionTitle: css({
    margin: theme.spacing(1, 0, 0),
  }),
});
