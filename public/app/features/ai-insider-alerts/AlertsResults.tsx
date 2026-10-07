import { css, cx } from '@emotion/css';
import { Fragment, useMemo, useState } from 'react';

import { GrafanaTheme2 } from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import {
  Badge,
  BadgeColor,
  Button,
  Icon,
  Input,
  RadioButtonGroup,
  Tab,
  TabsBar,
  useStyles2,
  useTheme2,
} from '@grafana/ui';
import { analytix } from 'app/features/home/analytixTokens';

import { IncidentTimeline, classColor } from './IncidentTimeline';
import { topKey } from './engine';
import { decisionsToCsv, formatCount, formatMinutes, formatUtc, formatUtcTime } from './format';
import type {
  AffectedUserRow,
  AlertSummary,
  CorrelationGroup,
  CustomerSideRow,
  DeadChannel,
  Decision,
  DecisionKind,
  Incident,
  IncidentClass,
} from './types';

/** Everything the results view renders, taken from the engine after each chunk. */
export interface AlertsSnapshot {
  summary: AlertSummary;
  incidents: Incident[];
  decisions: Decision[];
  customer: CustomerSideRow[];
  dead: DeadChannel[];
  groups: CorrelationGroup[];
  blips: number;
  classOf: (incident: Incident) => IncidentClass;
  affected: (incidentId: string) => AffectedUserRow[];
  from: number;
  to: number;
}

type TabId = 'incidents' | 'messages' | 'customer' | 'dead';
type KindFilter = DecisionKind | 'all';

const LOG_LIMIT = 300;
const USERS_LIMIT = 100;

function classBadge(cls: IncidentClass): { text: string; color: BadgeColor; tooltip: string } {
  switch (cls) {
    case 'push':
      return {
        text: t('ai-insider-alerts.class-push', 'Push'),
        color: 'red',
        tooltip: t(
          'ai-insider-alerts.class-push-tip',
          'Still failing after the push delay: viewers get a push, then "back"'
        ),
      };
    case 'in_app':
      return {
        text: t('ai-insider-alerts.class-in-app', 'In player'),
        color: 'orange',
        tooltip: t(
          'ai-insider-alerts.class-in-app-tip',
          'Recovered before a push was due: message in the player on retry only'
        ),
      };
    case 'chronic':
      return {
        text: t('ai-insider-alerts.class-chronic', 'Chronic'),
        color: 'darkgrey',
        tooltip: t(
          'ai-insider-alerts.class-chronic-tip',
          'Channel has had no clean viewing for hours: a status, not an incident'
        ),
      };
    default:
      return {
        text: t('ai-insider-alerts.class-pending', 'Open'),
        color: 'blue',
        tooltip: t('ai-insider-alerts.class-pending-tip', 'Confirmed, push not due yet'),
      };
  }
}

function kindBadge(kind: DecisionKind): { text: string; color: BadgeColor } {
  switch (kind) {
    case 'down':
      return { text: t('ai-insider-alerts.kind-down', 'Channel down'), color: 'red' };
    case 'back':
      return { text: t('ai-insider-alerts.kind-back', 'Back'), color: 'green' };
    case 'apology':
      return { text: t('ai-insider-alerts.kind-apology', 'Apology'), color: 'purple' };
    case 'in_app':
      return { text: t('ai-insider-alerts.kind-in-app', 'In player'), color: 'orange' };
    case 'suppressed':
      return { text: t('ai-insider-alerts.kind-suppressed', 'Held back'), color: 'darkgrey' };
    default:
      return { text: t('ai-insider-alerts.kind-diagnosis', 'Your connection'), color: 'blue' };
  }
}

function downloadCsv(decisions: Decision[]) {
  const blob = new Blob([decisionsToCsv(decisions)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ai-insider-alerts-messages.csv';
  a.click();
  URL.revokeObjectURL(url);
}

export function AlertsResults({ snapshot }: { snapshot: AlertsSnapshot }) {
  const styles = useStyles2(getStyles);
  const [tab, setTab] = useState<TabId>('incidents');
  const [expanded, setExpanded] = useState<string | undefined>();
  const { summary } = snapshot;

  const sent = summary.down + summary.back + summary.apology + summary.inApp + summary.diagnoses;
  const ratio = sent > 0 ? summary.naiveErrEvents / sent : undefined;

  const selectIncident = (id: string) => {
    setTab('incidents');
    setExpanded(id);
    requestAnimationFrame(() => document.getElementById(`ai-alert-${id}`)?.scrollIntoView({ block: 'center' }));
  };

  return (
    <div className={styles.results}>
      <div className={styles.tiles}>
        <Tile
          label={t('ai-insider-alerts.tile-incidents', 'Incidents')}
          value={formatCount(summary.incidents)}
          detail={t(
            'ai-insider-alerts.tile-incidents-detail',
            '{{push}} push · {{inApp}} in player · {{chronic}} chronic · {{open}} open',
            {
              push: summary.pushIncidents,
              inApp: summary.inAppIncidents,
              chronic: summary.chronicIncidents,
              open: summary.openIncidents,
            }
          )}
        />
        <Tile
          label={t('ai-insider-alerts.tile-down', '"Channel down" pushes')}
          value={formatCount(summary.down)}
          detail={t('ai-insider-alerts.tile-down-detail', '{{back}} "back" · {{apology}} apologies', {
            back: formatCount(summary.back),
            apology: formatCount(summary.apology),
          })}
        />
        <Tile
          label={t('ai-insider-alerts.tile-in-app', 'In-player messages')}
          value={formatCount(summary.inApp)}
          detail={t('ai-insider-alerts.tile-in-app-detail', 'short blips and chronic channels, no push')}
        />
        <Tile
          label={t('ai-insider-alerts.tile-held', 'Held back')}
          value={formatCount(summary.suppressedRepeats + summary.suppressedCooldown)}
          detail={t('ai-insider-alerts.tile-held-detail', '{{repeats}} repeated errors · {{cooldown}} already told', {
            repeats: formatCount(summary.suppressedRepeats),
            cooldown: formatCount(summary.suppressedCooldown),
          })}
        />
        <Tile
          label={t('ai-insider-alerts.tile-customer', 'Customer side')}
          value={formatCount(summary.diagnoses)}
          detail={t('ai-insider-alerts.tile-customer-detail', 'personal diagnoses · {{dead}} dead channels', {
            dead: summary.deadChannels,
          })}
        />
        <Tile
          accent
          label={t('ai-insider-alerts.tile-naive', 'Versus one message per error')}
          value={ratio === undefined ? '—' : `${ratio.toFixed(ratio >= 10 ? 0 : 1)}×`}
          detail={t(
            'ai-insider-alerts.tile-naive-detail',
            '{{errors}} errors → {{sent}} messages · detection lag {{lag}} min',
            {
              errors: formatCount(summary.naiveErrEvents),
              sent: formatCount(sent),
              lag: summary.medianDetectLagMin === undefined ? '—' : summary.medianDetectLagMin.toFixed(1),
            }
          )}
        />
      </div>

      <TabsBar className={styles.tabs}>
        <Tab
          label={t('ai-insider-alerts.tab-incidents', 'Incidents')}
          counter={snapshot.incidents.length}
          active={tab === 'incidents'}
          onChangeTab={() => setTab('incidents')}
        />
        <Tab
          label={t('ai-insider-alerts.tab-messages', 'Messages')}
          counter={snapshot.decisions.length}
          active={tab === 'messages'}
          onChangeTab={() => setTab('messages')}
        />
        <Tab
          label={t('ai-insider-alerts.tab-customer', 'Customer side')}
          counter={snapshot.customer.length}
          active={tab === 'customer'}
          onChangeTab={() => setTab('customer')}
        />
        <Tab
          label={t('ai-insider-alerts.tab-dead', 'Dead channels')}
          counter={snapshot.dead.length}
          active={tab === 'dead'}
          onChangeTab={() => setTab('dead')}
        />
      </TabsBar>

      <div className={styles.tabBody}>
        {tab === 'incidents' && (
          <IncidentsTab snapshot={snapshot} expanded={expanded} onToggle={setExpanded} onSelect={selectIncident} />
        )}
        {tab === 'messages' && <MessagesTab decisions={snapshot.decisions} onSelect={selectIncident} />}
        {tab === 'customer' && <CustomerTab rows={snapshot.customer} />}
        {tab === 'dead' && <DeadTab rows={snapshot.dead} />}
      </div>
    </div>
  );
}

function Tile({ label, value, detail, accent }: { label: string; value: string; detail: string; accent?: boolean }) {
  const styles = useStyles2(getStyles);
  return (
    <div className={cx(styles.tile, accent && styles.tileAccent)}>
      <div className={styles.tileLabel}>{label}</div>
      <div className={styles.tileValue}>{value}</div>
      <div className={styles.tileDetail}>{detail}</div>
    </div>
  );
}

function IncidentsTab({
  snapshot,
  expanded,
  onToggle,
  onSelect,
}: {
  snapshot: AlertsSnapshot;
  expanded?: string;
  onToggle: (id?: string) => void;
  onSelect: (id: string) => void;
}) {
  const styles = useStyles2(getStyles);
  const groups = useMemo(() => new Map(snapshot.groups.map((g) => [g.id, g])), [snapshot.groups]);

  if (!snapshot.incidents.length) {
    return (
      <p className={styles.empty}>
        <Trans i18nKey="ai-insider-alerts.no-incidents">
          No channel incidents so far. Single failing minutes that never confirmed are ignored.
        </Trans>
      </p>
    );
  }

  return (
    <>
      <IncidentTimeline
        incidents={snapshot.incidents}
        classOf={snapshot.classOf}
        from={snapshot.from}
        to={snapshot.to}
        onSelect={onSelect}
      />
      <div className={styles.legend}>
        <Trans i18nKey="ai-insider-alerts.timeline-legend">
          Bar: failing → recovered. Tick: detected. Diamond: push due. Top 40 by peak viewers with errors; click a lane
          to open it.
        </Trans>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>
                <Trans i18nKey="ai-insider-alerts.col-started">Started (UTC)</Trans>
              </th>
              <th>
                <Trans i18nKey="ai-insider-alerts.col-detected">Detected</Trans>
              </th>
              <th>
                <Trans i18nKey="ai-insider-alerts.col-back">Back</Trans>
              </th>
              <th>
                <Trans i18nKey="ai-insider-alerts.col-channel">Provider · channel</Trans>
              </th>
              <th>
                <Trans i18nKey="ai-insider-alerts.col-class">Class</Trans>
              </th>
              <th className={styles.num}>
                <Trans i18nKey="ai-insider-alerts.col-peak">Peak errors</Trans>
              </th>
              <th className={styles.num}>
                <Trans i18nKey="ai-insider-alerts.col-viewers">Viewers hit</Trans>
              </th>
              <th>
                <Trans i18nKey="ai-insider-alerts.col-evidence">Evidence</Trans>
              </th>
            </tr>
          </thead>
          <tbody>
            {snapshot.incidents.map((inc) => {
              const cls = snapshot.classOf(inc);
              const badge = classBadge(cls);
              const open = expanded === inc.id;
              const group = inc.groupId ? groups.get(inc.groupId) : undefined;
              return (
                <Fragment key={inc.id}>
                  <tr
                    id={`ai-alert-${inc.id}`}
                    className={cx(styles.clickable, open && styles.rowOpen)}
                    onClick={() => onToggle(open ? undefined : inc.id)}
                  >
                    <td>{formatUtc(inc.start)}</td>
                    <td>
                      {formatUtcTime(inc.detectedAt)}
                      <span className={styles.sub}>+{formatMinutes(inc.start, inc.detectedAt)}</span>
                    </td>
                    <td>
                      {inc.closedAt ? (
                        <>
                          {formatUtcTime(inc.closedAt)}
                          <span className={styles.sub}>{formatMinutes(inc.start, inc.closedAt)}</span>
                        </>
                      ) : (
                        <Trans i18nKey="ai-insider-alerts.still-failing">still failing</Trans>
                      )}
                    </td>
                    <td>
                      <strong>{inc.title || inc.cid}</strong>
                      <span className={styles.sub}>
                        {inc.provider ? `${inc.pid} ${inc.provider}` : inc.pid}
                        {inc.reopenOf ? ` · ${t('ai-insider-alerts.reopened', 'flapping')}` : ''}
                      </span>
                    </td>
                    <td>
                      <Badge text={badge.text} color={badge.color} tooltip={badge.tooltip} />
                    </td>
                    <td className={styles.num}>
                      {inc.peakErrUsers}/{inc.peakUsers}
                      <span className={styles.sub}>{Math.round(inc.peakErrShare * 100)}%</span>
                    </td>
                    <td className={styles.num}>{formatCount(snapshot.affected(inc.id).length)}</td>
                    <td className={styles.evidence}>
                      <span className={styles.mono}>{topKey(inc.paths) || topKey(inc.hosts) || '—'}</span>
                      <span className={styles.sub}>
                        {topKey(inc.platforms)} · {topKey(inc.codes)}
                        {group ? ` · ${group.label}` : ''}
                      </span>
                    </td>
                  </tr>
                  {open && (
                    <tr className={styles.detailRow}>
                      <td colSpan={8}>
                        <IncidentDetails incident={inc} snapshot={snapshot} cls={cls} groupLabel={group?.label} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function IncidentDetails({
  incident,
  snapshot,
  cls,
  groupLabel,
}: {
  incident: Incident;
  snapshot: AlertsSnapshot;
  cls: IncidentClass;
  groupLabel?: string;
}) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const users = snapshot.affected(incident.id);
  const decisions = snapshot.decisions.filter((d) => d.incidentId === incident.id);
  const byUser = new Map<string, DecisionKind>();
  for (const d of decisions) {
    if (d.kind === 'down' || d.kind === 'in_app' || (d.kind === 'suppressed' && !byUser.has(d.userId))) {
      byUser.set(d.userId, d.kind);
    }
  }
  const counts = (kind: DecisionKind) => decisions.filter((d) => d.kind === kind).length;

  // Sparkline over the incident's life: one bar per minute, height = share of
  // viewers with errors (bad minutes only; clean minutes stay empty).
  const end = incident.closedAt ?? Math.max(incident.lastBad + 60, snapshot.to);
  const minutes = Math.max(1, Math.round((end - incident.start) / 60));
  const w = 600;
  const h = 48;
  const bw = Math.max(1, w / minutes);

  const breakdown = (map: Record<string, number>) =>
    Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, v]) => `${k || '—'} (${v})`)
      .join(', ');

  return (
    <div className={styles.details}>
      <svg viewBox={`0 0 ${w} ${h}`} className={styles.spark} preserveAspectRatio="none" aria-hidden>
        {incident.series.map((p) => {
          const share = p.users ? p.errUsers / p.users : 0;
          const bh = Math.max(1, share * (h - 2));
          return (
            <rect
              key={p.minute}
              x={((p.minute - incident.start) / 60) * bw}
              y={h - bh}
              width={Math.max(1, bw - 0.5)}
              height={bh}
              fill={classColor(theme, cls)}
            />
          );
        })}
      </svg>
      <div className={styles.detailGrid}>
        <div>
          <div className={styles.detailLabel}>
            <Trans i18nKey="ai-insider-alerts.detail-messages">Messages</Trans>
          </div>
          {t(
            'ai-insider-alerts.detail-messages-value',
            '{{down}} down · {{back}} back · {{apology}} apology · {{inApp}} in player · {{held}} held back',
            {
              down: counts('down'),
              back: counts('back'),
              apology: counts('apology'),
              inApp: counts('in_app'),
              held: counts('suppressed'),
            }
          )}
        </div>
        <div>
          <div className={styles.detailLabel}>
            <Trans i18nKey="ai-insider-alerts.detail-timing">Timing (UTC)</Trans>
          </div>
          {t(
            'ai-insider-alerts.detail-timing-value',
            'start {{start}} · detected {{detected}} · push due {{push}} · back {{back}} · {{bad}} failing minutes',
            {
              start: formatUtcTime(incident.start),
              detected: formatUtcTime(incident.detectedAt),
              push: formatUtcTime(incident.escalatedAt),
              back: formatUtcTime(incident.closedAt),
              bad: incident.badMinutes,
            }
          )}
        </div>
        <div>
          <div className={styles.detailLabel}>
            <Trans i18nKey="ai-insider-alerts.detail-where">Where it fails</Trans>
          </div>
          <span className={styles.mono}>{breakdown(incident.paths)}</span>
          <div className={styles.sub}>
            {breakdown(incident.platforms)} · {breakdown(incident.codes)}
          </div>
          {groupLabel && <div className={styles.sub}>{groupLabel}</div>}
        </div>
      </div>
      <table className={cx(styles.table, styles.innerTable)}>
        <thead>
          <tr>
            <th>
              <Trans i18nKey="ai-insider-alerts.col-viewer">Viewer</Trans>
            </th>
            <th>
              <Trans i18nKey="ai-insider-alerts.col-platform">Platform · network</Trans>
            </th>
            <th>
              <Trans i18nKey="ai-insider-alerts.col-first-error">First error</Trans>
            </th>
            <th className={styles.num}>
              <Trans i18nKey="ai-insider-alerts.col-errors">Errors</Trans>
            </th>
            <th className={styles.num}>
              <Trans i18nKey="ai-insider-alerts.col-watched">Watched before</Trans>
            </th>
            <th>
              <Trans i18nKey="ai-insider-alerts.col-decision">Decision</Trans>
            </th>
          </tr>
        </thead>
        <tbody>
          {users.slice(0, USERS_LIMIT).map((u) => {
            const kind = byUser.get(u.userId);
            const badge = kind ? kindBadge(kind) : undefined;
            return (
              <tr key={u.userId}>
                <td className={styles.mono}>{u.userId}</td>
                <td>
                  {u.platform} · {u.network || '—'}
                </td>
                <td>{formatUtcTime(u.firstErr)}</td>
                <td className={styles.num}>{u.errEvents}</td>
                <td className={styles.num}>{formatMinutes(0, u.watchedBeforeSec)}</td>
                <td>
                  {badge ? (
                    <Badge text={badge.text} color={badge.color} />
                  ) : (
                    <span className={styles.sub}>
                      <Trans i18nKey="ai-insider-alerts.decision-none">nothing: error ended before detection</Trans>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {users.length > USERS_LIMIT && (
        <div className={styles.sub}>
          {t('ai-insider-alerts.more-viewers', '…and {{count}} more viewers (see Messages, or export CSV)', {
            count: users.length - USERS_LIMIT,
          })}
        </div>
      )}
    </div>
  );
}

function MessagesTab({ decisions, onSelect }: { decisions: Decision[]; onSelect: (id: string) => void }) {
  const styles = useStyles2(getStyles);
  const [kind, setKind] = useState<KindFilter>('all');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return decisions.filter(
      (d) =>
        (kind === 'all' || d.kind === kind) &&
        (!q || `${d.userId} ${d.title} ${d.provider} ${d.pid}`.toLowerCase().includes(q))
    );
  }, [decisions, kind, search]);

  const options: Array<{ label: string; value: KindFilter }> = [
    { label: t('ai-insider-alerts.filter-all', 'All'), value: 'all' },
    { label: kindBadge('down').text, value: 'down' },
    { label: kindBadge('back').text, value: 'back' },
    { label: kindBadge('apology').text, value: 'apology' },
    { label: kindBadge('in_app').text, value: 'in_app' },
    { label: kindBadge('suppressed').text, value: 'suppressed' },
    { label: kindBadge('diagnosis').text, value: 'diagnosis' },
  ];

  return (
    <>
      <div className={styles.toolbar}>
        <RadioButtonGroup size="sm" options={options} value={kind} onChange={setKind} />
        <Input
          className={styles.search}
          prefix={<Icon name="search" />}
          placeholder={t('ai-insider-alerts.search-placeholder', 'Viewer, channel or provider')}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
        <Button size="sm" variant="secondary" icon="download-alt" onClick={() => downloadCsv(filtered)}>
          <Trans i18nKey="ai-insider-alerts.export-csv">Export CSV</Trans>
        </Button>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>
                <Trans i18nKey="ai-insider-alerts.col-time">Time (UTC)</Trans>
              </th>
              <th>
                <Trans i18nKey="ai-insider-alerts.col-message">Message</Trans>
              </th>
              <th>
                <Trans i18nKey="ai-insider-alerts.col-viewer">Viewer</Trans>
              </th>
              <th>
                <Trans i18nKey="ai-insider-alerts.col-channel">Provider · channel</Trans>
              </th>
              <th>
                <Trans i18nKey="ai-insider-alerts.col-why">Why</Trans>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, LOG_LIMIT).map((d, i) => {
              const badge = kindBadge(d.kind);
              return (
                <tr key={`${d.kind}-${d.userId}-${d.incidentId ?? ''}-${i}`}>
                  <td>{formatUtc(d.at)}</td>
                  <td>
                    <Badge text={badge.text} color={badge.color} />
                  </td>
                  <td className={styles.mono}>
                    {d.userId}
                    <span className={styles.sub}>{d.platform}</span>
                  </td>
                  <td>
                    {d.incidentId ? (
                      <button type="button" className={styles.link} onClick={() => onSelect(d.incidentId!)}>
                        {d.title || d.cid}
                      </button>
                    ) : (
                      d.title
                    )}
                    <span className={styles.sub}>{d.provider ? `${d.pid} ${d.provider}` : d.pid}</span>
                  </td>
                  <td className={styles.why}>{d.reason}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {filtered.length > LOG_LIMIT && (
        <div className={styles.legend}>
          {t('ai-insider-alerts.log-truncated', 'Showing {{shown}} of {{total}}. Export CSV for the full log.', {
            shown: LOG_LIMIT,
            total: formatCount(filtered.length),
          })}
        </div>
      )}
    </>
  );
}

function CustomerTab({ rows }: { rows: CustomerSideRow[] }) {
  const styles = useStyles2(getStyles);
  if (!rows.length) {
    return (
      <p className={styles.empty}>
        <Trans i18nKey="ai-insider-alerts.no-customer">No viewer failed on several healthy channels.</Trans>
      </p>
    );
  }
  return (
    <>
      <div className={styles.legend}>
        <Trans i18nKey="ai-insider-alerts.customer-legend">
          Viewers with errors on several channels that worked for everyone else at the same minute: the cause is likely
          their home network or device. They get a personal diagnosis, once a day, never the operator message.
        </Trans>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>
                <Trans i18nKey="ai-insider-alerts.col-viewer">Viewer</Trans>
              </th>
              <th>
                <Trans i18nKey="ai-insider-alerts.col-provider">Provider</Trans>
              </th>
              <th>
                <Trans i18nKey="ai-insider-alerts.col-platform">Platform · network</Trans>
              </th>
              <th className={styles.num}>
                <Trans i18nKey="ai-insider-alerts.col-channels">Channels</Trans>
              </th>
              <th className={styles.num}>
                <Trans i18nKey="ai-insider-alerts.col-minutes">Minutes</Trans>
              </th>
              <th className={styles.num}>
                <Trans i18nKey="ai-insider-alerts.col-errors">Errors</Trans>
              </th>
              <th>
                <Trans i18nKey="ai-insider-alerts.col-window">Window (UTC)</Trans>
              </th>
              <th>
                <Trans i18nKey="ai-insider-alerts.col-code">Top code</Trans>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, LOG_LIMIT).map((r) => (
              <tr key={`${r.pid}-${r.userId}-${r.lastMinute}`}>
                <td className={styles.mono}>{r.userId}</td>
                <td>{r.provider ? `${r.pid} ${r.provider}` : r.pid}</td>
                <td>
                  {r.platform} · {r.network || '—'}
                </td>
                <td className={styles.num}>{r.channels}</td>
                <td className={styles.num}>{r.minutes}</td>
                <td className={styles.num}>{r.errEvents}</td>
                <td>
                  {formatUtc(r.firstMinute)} – {formatUtcTime(r.lastMinute + 60)}
                </td>
                <td className={styles.mono}>{r.topCode}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function DeadTab({ rows }: { rows: DeadChannel[] }) {
  const styles = useStyles2(getStyles);
  if (!rows.length) {
    return (
      <p className={styles.empty}>
        <Trans i18nKey="ai-insider-alerts.no-dead">No channel stayed unavailable for hours.</Trans>
      </p>
    );
  }
  return (
    <>
      <div className={styles.legend}>
        <Trans i18nKey="ai-insider-alerts.dead-legend">
          Channels with server errors (4xx/5xx, stream not found) and not a single clean viewing for three hours. They
          need a status in the line-up and a ticket, not a push to viewers.
        </Trans>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>
                <Trans i18nKey="ai-insider-alerts.col-channel">Provider · channel</Trans>
              </th>
              <th className={styles.num}>
                <Trans i18nKey="ai-insider-alerts.col-srv-users">Viewers with server errors</Trans>
              </th>
              <th className={styles.num}>
                <Trans i18nKey="ai-insider-alerts.col-tried">Tried to watch</Trans>
              </th>
              <th>
                <Trans i18nKey="ai-insider-alerts.col-seen">Seen dead (UTC)</Trans>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.pid}-${r.cid}`}>
                <td>
                  <strong>{r.title || r.cid}</strong>
                  <span className={styles.sub}>{r.provider ? `${r.pid} ${r.provider}` : r.pid}</span>
                </td>
                <td className={styles.num}>{r.srvErrUsers}</td>
                <td className={styles.num}>{r.triedUsers}</td>
                <td>
                  {formatUtc(r.firstSeen)} – {formatUtc(r.lastSeen)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  results: css({
    display: 'grid',
    gap: theme.spacing(2),
  }),
  tiles: css({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
    gap: 12,
  }),
  tile: css({
    background: analytix.surfaceRaised,
    border: `1px solid ${analytix.border}`,
    borderRadius: analytix.radiusCard,
    padding: theme.spacing(1.5, 2),
    minWidth: 0,
  }),
  tileAccent: css({
    borderColor: analytix.greenDark,
  }),
  tileLabel: css({
    color: analytix.textMuted,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  tileValue: css({
    fontSize: 28,
    fontWeight: theme.typography.fontWeightMedium,
    color: analytix.text,
    lineHeight: 1.3,
    fontVariantNumeric: 'tabular-nums',
  }),
  tileDetail: css({
    color: analytix.textFaint,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  tabs: css({
    marginTop: theme.spacing(1),
  }),
  tabBody: css({
    display: 'grid',
    gap: theme.spacing(1.5),
    minWidth: 0,
  }),
  legend: css({
    color: analytix.textFaint,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  empty: css({
    color: analytix.textMuted,
    padding: theme.spacing(3, 0),
  }),
  toolbar: css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(1),
    alignItems: 'center',
  }),
  search: css({
    width: 260,
    maxWidth: '100%',
  }),
  tableWrap: css({
    overflowX: 'auto',
    border: `1px solid ${analytix.border}`,
    borderRadius: analytix.radiusCard,
  }),
  table: css({
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: theme.typography.bodySmall.fontSize,
    'th, td': {
      textAlign: 'left',
      verticalAlign: 'top',
      padding: theme.spacing(0.75, 1.25),
      borderBottom: `1px solid ${analytix.border}`,
    },
    th: {
      color: analytix.textMuted,
      fontWeight: theme.typography.fontWeightMedium,
      background: analytix.surfaceRaised,
      whiteSpace: 'nowrap',
    },
    'tbody tr:last-child td': {
      borderBottom: 0,
    },
  }),
  innerTable: css({
    border: `1px solid ${analytix.border}`,
  }),
  num: css({
    // Doubled selector: beats the table's `th, td` left alignment.
    '&&': {
      textAlign: 'right',
    },
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  }),
  sub: css({
    display: 'block',
    color: analytix.textFaint,
    fontSize: 12,
  }),
  mono: css({
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: 12,
    wordBreak: 'break-all',
  }),
  evidence: css({
    maxWidth: 340,
  }),
  why: css({
    color: analytix.textDim,
    minWidth: 240,
  }),
  clickable: css({
    cursor: 'pointer',
    '&:hover td': {
      background: theme.colors.action.hover,
    },
  }),
  rowOpen: css({
    td: {
      background: analytix.control,
    },
  }),
  detailRow: css({
    td: {
      background: analytix.controlSunken,
    },
  }),
  details: css({
    display: 'grid',
    gap: theme.spacing(1.5),
    padding: theme.spacing(1, 0),
  }),
  spark: css({
    width: '100%',
    height: 48,
    display: 'block',
    background: analytix.surface,
    borderRadius: analytix.radiusControl,
  }),
  detailGrid: css({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
    gap: theme.spacing(2),
  }),
  detailLabel: css({
    color: analytix.textMuted,
    fontWeight: theme.typography.fontWeightMedium,
    marginBottom: 2,
  }),
  link: css({
    background: 'none',
    border: 0,
    padding: 0,
    color: analytix.greenBright,
    cursor: 'pointer',
    textAlign: 'left',
    '&:hover': {
      textDecoration: 'underline',
    },
  }),
});
