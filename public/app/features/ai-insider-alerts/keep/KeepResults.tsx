// Analytix: AI Insider Alerts — "Keep the customer" results: what the rules
// found on the as-of day, as ready jobs for marketing (who, what, when, why),
// renewals, upsell leads, support hand-offs, data quality and the backtest.
// Nothing is sent from here; the Jobs tab exports the hand-off.

import { css, cx } from '@emotion/css';
import { Fragment, useEffect, useMemo, useState } from 'react';

import { GrafanaTheme2 } from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import {
  Badge,
  BadgeColor,
  Button,
  Checkbox,
  ConfirmModal,
  Icon,
  IconButton,
  Input,
  RadioButtonGroup,
  Tab,
  TabsBar,
  useStyles2,
} from '@grafana/ui';
import { analytix } from 'app/features/home/analytixTokens';

import { Tile, getStyles as getResultsStyles } from '../AlertsResults';
import { formatCount, formatUtc } from '../format';

import { ruleDays } from './engine';
import {
  controlKeysOf,
  downloadControlJson,
  downloadJobsCsv,
  downloadLeadsCsv,
  downloadSupportCsv,
  KeepFileKind,
  marketingJobs,
  salesLeads,
} from './export';
import {
  actionText,
  deliveryText,
  EvidenceContext,
  evidenceSentence,
  isoDay,
  jobActionText,
  localTime,
  offerText,
  planClassText,
  RAW,
  reasonText,
  styleText,
  tierText,
  utcOffsetLabel,
} from './text';
import type {
  AccountAssessment,
  BacktestReport,
  BehaviorStatus,
  Delivery,
  KeepAction,
  KeepJob,
  KeepQuality,
  KeepRules,
  KeepSnapshot,
  OutcomeGroup,
  PlanClass,
  PriorityTier,
  RenewalItem,
  RenewalStyle,
  WindowStats,
} from './types';

type TabId = 'jobs' | 'renewals' | 'leads' | 'support' | 'quality' | 'backtest';
type ExportKind = KeepFileKind;

const LIST_LIMIT = 300;
const NONE = '—';
const DAY = 86400;
const STYLES: RenewalStyle[] = ['repurchase', 'early', 'at_term', 'unknown'];
const ACTIONS: KeepAction[] = ['content_push', 're_engagement', 'retention_offer', 'renewal_campaign', 'support'];
const DELIVERIES: Delivery[] = ['push', 'crm', 'none', 'unset'];

export interface KeepResultsProps {
  snapshot: KeepSnapshot;
  /** The rules the snapshot was made with (window lengths, control group). */
  rules: KeepRules;
  includeTitles: boolean;
  onIncludeTitlesChange: (include: boolean) => void;
  /** Plan class overrides in the settings; may be newer than the snapshot (they apply on the next run). */
  planClassOverrides: Record<string, PlanClass>;
  onPlanClassChange: (pid: string, plan: string, cls: PlanClass | undefined) => void;
  /** Called after a file was saved (telemetry). */
  onExport?: (kind: ExportKind, rows: number) => void;
}

function deliveryColor(delivery: Delivery): BadgeColor {
  return delivery === 'push' ? 'blue' : delivery === 'crm' ? 'purple' : delivery === 'none' ? 'darkgrey' : 'orange';
}

function tierColor(tier: PriorityTier): BadgeColor {
  return tier === 'high' ? 'red' : tier === 'medium' ? 'orange' : 'blue';
}

function actionColor(action: KeepAction): BadgeColor {
  switch (action) {
    case 'content_push':
      return 'green';
    case 're_engagement':
      return 'blue';
    case 'retention_offer':
      return 'purple';
    case 'renewal_campaign':
      return 'orange';
    default:
      return 'red';
  }
}

function behaviorText(status: BehaviorStatus | undefined): string {
  switch (status?.status) {
    case 'on':
      return t('ai-insider-alerts.keep.ga4-on', 'On');
    case 'partial':
      return t('ai-insider-alerts.keep.ga4-partial', 'Partial');
    case 'pending':
      return t('ai-insider-alerts.keep.ga4-pending', 'Pending');
    case 'budget':
      return t('ai-insider-alerts.keep.ga4-budget', 'Budget used');
    case 'error':
      return t('ai-insider-alerts.keep.ga4-error', 'Error');
    case 'unavailable':
      return t('ai-insider-alerts.keep.ga4-unavailable', 'Unavailable');
    default:
      return t('ai-insider-alerts.keep.ga4-off', 'Off');
  }
}

function behaviorDetail(status: BehaviorStatus | undefined): string {
  if (!status) {
    return t('ai-insider-alerts.keep.ga4-not-requested', 'not requested for this run');
  }
  const parts: string[] = [];
  if (status.matched !== undefined && status.requested !== undefined) {
    parts.push(
      t('ai-insider-alerts.keep.ga4-matched', '{{matched}} of {{requested}} customers matched', {
        matched: formatCount(status.matched),
        requested: formatCount(status.requested),
      })
    );
  }
  if (status.notLinked) {
    parts.push(
      t('ai-insider-alerts.keep.ga4-not-linked', '{{accounts}} customers of providers without GA4', {
        accounts: formatCount(status.notLinked),
      })
    );
  }
  if (status.window) {
    parts.push(`${status.window.from} – ${status.window.to}`);
  }
  if (status.message) {
    parts.push(status.message);
  }
  return parts.join(' · ') || t('ai-insider-alerts.keep.ga4-no-detail', 'app behavior of the at-risk customers');
}

function groupText(group: OutcomeGroup): string {
  switch (group) {
    case 'price':
      return t('ai-insider-alerts.keep.group-price', 'Price (not renewed)');
    case 'timing':
      return t('ai-insider-alerts.keep.group-timing', 'Timing (not renewed)');
    case 'content':
      return t('ai-insider-alerts.keep.group-content', 'Content (did not recover)');
    case 'disengaged':
      return t('ai-insider-alerts.keep.group-disengaged', 'Disengaged (did not recover)');
    default:
      return t('ai-insider-alerts.keep.group-quiet', 'Quiet only (did not come back)');
  }
}

/** Kind of a refused-playback code: subscription not active, another package, or outside the paywall definition. */
function paywallKindBadge(kind: KeepQuality['paywall'][number]['kind']): {
  text: string;
  color: BadgeColor;
  tooltip: string;
} {
  switch (kind) {
    case 'inactive':
      return {
        text: t('ai-insider-alerts.keep.paywall-inactive', 'Not active'),
        color: 'orange',
        tooltip: t('ai-insider-alerts.keep.paywall-inactive-tip', 'Refused: the subscription is not active'),
      };
    case 'premium':
      return {
        text: t('ai-insider-alerts.keep.paywall-premium', 'Other package'),
        color: 'purple',
        tooltip: t('ai-insider-alerts.keep.paywall-premium-tip', 'Refused: the content needs another package'),
      };
    default:
      return {
        text: t('ai-insider-alerts.keep.paywall-candidate', 'Not in the definition'),
        color: 'darkgrey',
        tooltip: t(
          'ai-insider-alerts.keep.paywall-candidate-tip',
          'Not in the paywall definition yet: a form to confirm before it counts as a refusal'
        ),
      };
  }
}

function renewalKindBadge(kind: RenewalItem['kind']): { text: string; color: BadgeColor } {
  switch (kind) {
    case 'at_risk':
      return { text: t('ai-insider-alerts.keep.renewal-at-risk', 'At risk'), color: 'red' };
    case 'check_autopay':
      return { text: t('ai-insider-alerts.keep.renewal-check-autopay', 'Check autopay'), color: 'blue' };
    default:
      return {
        text: t('ai-insider-alerts.keep.renewal-expired-silent', 'Expired, no renewal seen'),
        color: 'darkgrey',
      };
  }
}

const pctText = (share: number | null | undefined) =>
  share === null || share === undefined || !Number.isFinite(share) ? NONE : `${Math.round(share * 100)}%`;

const perDay = (value: number, days: number) => (days > 0 ? (value / days).toFixed(1).replace(/\.0$/, '') : '—');

/** What the evidence sentences of one account need from its assessment. */
function evidenceContext(a: AccountAssessment | undefined, rules: KeepRules): EvidenceContext {
  return a ? { recentWatchPerDay: a.recent.watchAllMin / ruleDays(rules.recentDays) } : {};
}

/** Matches an account by its number or by its key (no dashes); null when the search is empty. */
function accountMatcher(search: string): ((account: string, accountKey?: string) => boolean) | null {
  const q = search.trim().toLowerCase();
  if (!q) {
    return null;
  }
  const qKey = q.replace(/-/g, '');
  return (account, accountKey = account.replace(/-/g, '')) =>
    account.toLowerCase().includes(q) || (qKey !== '' && accountKey.toLowerCase().includes(qKey));
}

function AccountSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const styles = useStyles2(getResultsStyles);
  return (
    <Input
      className={styles.search}
      prefix={<Icon name="search" />}
      placeholder={t('ai-insider-alerts.keep.search-placeholder', 'Account')}
      aria-label={t('ai-insider-alerts.keep.search-label', 'Search account')}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
    />
  );
}

/** The toggle of an expandable row for the keyboard and screen readers (a click on the row does the same). */
function RowToggle({ open, label, onToggle }: { open: boolean; label: string; onToggle: () => void }) {
  const own = useStyles2(getKeepStyles);
  return (
    <IconButton
      className={own.toggle}
      name={open ? 'angle-down' : 'angle-right'}
      size="sm"
      aria-label={label}
      aria-expanded={open}
      onClick={(e) => {
        // The row toggles on a click as well: do not toggle twice.
        e.stopPropagation();
        onToggle();
      }}
    />
  );
}

const rowLabel = (account: string) =>
  t('ai-insider-alerts.keep.row-details', 'Details of {{account}}', { account, ...RAW });

/**
 * A customer whose job is in the control group: lists meant for the CRM or
 * sales must not get them contacted. On the Support list only promotions are
 * withheld — the technical problem is handled as usual.
 */
function ControlBadge({ support = false }: { support?: boolean }) {
  return support ? (
    <Badge
      text={t('ai-insider-alerts.keep.control-no-promotions', 'Control group — no promotions')}
      color="darkgrey"
      tooltip={t(
        'ai-insider-alerts.keep.control-support-tip',
        'Help with the technical problem as usual; no marketing contact (effect measurement)'
      )}
    />
  ) : (
    <Badge
      text={t('ai-insider-alerts.keep.control-do-not-contact', 'Control — do not contact')}
      color="darkgrey"
      tooltip={t('ai-insider-alerts.keep.control-tip', 'In the control group: never contacted, to measure the effect')}
    />
  );
}

/** Every hand-off file carries subscriber identifiers: ask before saving one. */
function ExportConfirm({
  isOpen,
  onConfirm,
  onDismiss,
}: {
  isOpen: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  return (
    <ConfirmModal
      isOpen={isOpen}
      title={t('ai-insider-alerts.keep.export-confirm-title', 'Save subscriber data?')}
      body={
        <Trans i18nKey="ai-insider-alerts.keep.export-confirm-body">
          The file contains subscriber identifiers (account numbers and profile ids). Store and share it only as your
          organisation allows. Consent to marketing and opt-outs are not known to Analytix: checking them is the job of
          the team that receives the file.
        </Trans>
      }
      confirmText={t('ai-insider-alerts.keep.export-confirm', 'Save file')}
      confirmVariant="primary"
      onConfirm={onConfirm}
      onDismiss={onDismiss}
    />
  );
}

/** Figures of the tiles, from one snapshot. */
function summarize(snapshot: KeepSnapshot) {
  const treatment = snapshot.jobs.filter((j) => !j.control);
  const ready = treatment.filter(
    (j) => !j.deferred && j.action !== 'support' && (j.delivery === 'push' || j.delivery === 'crm')
  );
  const winBack = treatment.filter((j) => j.offerKind === 'win_back' || j.offerKind === 'win_back_free');
  const renewals = (kind: RenewalItem['kind']) => snapshot.renewals.filter((r) => r.kind === kind).length;
  return {
    ready: ready.length,
    readyHigh: ready.filter((j) => j.tier === 'high').length,
    deferred: treatment.filter((j) => j.deferred).length,
    renewalsAtRisk: renewals('at_risk'),
    campaigns: treatment.filter((j) => j.action === 'renewal_campaign').length,
    checkAutopay: renewals('check_autopay'),
    expiredSilent: renewals('expired_silent'),
    winBack: winBack.length,
    winBackStep1: winBack.filter((j) => j.offerKind === 'win_back' && j.offerStep !== 2).length,
    winBackStep2: winBack.filter((j) => j.offerKind === 'win_back' && j.offerStep === 2).length,
    winBackFree: winBack.filter((j) => j.offerKind === 'win_back_free').length,
    unset: treatment.filter((j) => j.delivery === 'unset').length,
    noChannel: treatment.filter((j) => j.delivery === 'none').length,
    support: snapshot.support.length,
    supportTech: snapshot.support.filter((a) => a.techIssue).length,
    // The in-window flag: an older deactivation (still in the renewal history) does not count.
    supportDeactivated: snapshot.support.filter((a) => a.deactivated).length,
    control: snapshot.jobs.length - treatment.length,
  };
}

export function KeepResults({
  snapshot,
  rules,
  includeTitles,
  onIncludeTitlesChange,
  planClassOverrides,
  onPlanClassChange,
  onExport,
}: KeepResultsProps) {
  const styles = useStyles2(getResultsStyles);
  const [tab, setTab] = useState<TabId>(snapshot.backtest ? 'backtest' : 'jobs');
  const figures = useMemo(() => summarize(snapshot), [snapshot]);
  const byKey = useMemo(() => new Map(snapshot.assessments.map((a) => [a.key, a])), [snapshot.assessments]);
  const controlKeys = useMemo(() => controlKeysOf(snapshot.jobs), [snapshot.jobs]);
  const hasBacktest = Boolean(snapshot.backtest);

  // A backtest run lands on its report; a later scan without one leaves the tab.
  useEffect(() => {
    setTab((current) => (hasBacktest ? 'backtest' : current === 'backtest' ? 'jobs' : current));
  }, [hasBacktest]);

  const { quality } = snapshot;

  return (
    <div className={styles.results}>
      <div className={styles.legend}>
        {t(
          'ai-insider-alerts.keep.results-head',
          'As of {{day}} (UTC) · providers: {{pids}} · {{accounts}} customers seen, {{eligible}} judged',
          {
            day: isoDay(snapshot.asOf),
            pids: snapshot.pids === null ? t('ai-insider-alerts.keep.all-providers', 'all') : snapshot.pids.join(', '),
            accounts: formatCount(quality.accounts),
            eligible: formatCount(quality.eligible),
          }
        )}
      </div>
      <div className={styles.tiles}>
        <Tile
          accent
          label={t('ai-insider-alerts.keep.tile-ready', 'Ready jobs')}
          value={formatCount(figures.ready)}
          detail={t('ai-insider-alerts.keep.tile-ready-detail', '{{high}} high priority · {{deferred}} deferred', {
            high: formatCount(figures.readyHigh),
            deferred: formatCount(figures.deferred),
          })}
        />
        <Tile
          label={t('ai-insider-alerts.keep.tile-renewals', 'Renewals at risk')}
          value={formatCount(figures.renewalsAtRisk)}
          detail={t('ai-insider-alerts.keep.tile-renewals-detail', '{{campaigns}} renewal campaigns', {
            campaigns: formatCount(figures.campaigns),
          })}
        />
        <Tile
          label={t('ai-insider-alerts.keep.tile-win-back', 'Hot win-back')}
          value={formatCount(figures.winBack)}
          detail={t(
            'ai-insider-alerts.keep.tile-win-back-detail',
            '{{step1}} payment link · {{step2}} discount · {{free}} from free',
            {
              step1: formatCount(figures.winBackStep1),
              step2: formatCount(figures.winBackStep2),
              free: formatCount(figures.winBackFree),
            }
          )}
        />
        <Tile
          label={t('ai-insider-alerts.keep.tile-autopay', 'Check autopay')}
          value={formatCount(figures.checkAutopay)}
          detail={t(
            'ai-insider-alerts.keep.tile-autopay-detail',
            'ending soon, no job · {{silent}} expired, no renewal seen',
            {
              silent: formatCount(figures.expiredSilent),
            }
          )}
        />
        <Tile
          label={t('ai-insider-alerts.keep.tile-unset', 'No channel set')}
          value={formatCount(figures.unset)}
          detail={t(
            'ai-insider-alerts.keep.tile-unset-detail',
            'set delivery per provider · {{none}} on providers without a channel',
            { none: formatCount(figures.noChannel) }
          )}
        />
        <Tile
          label={t('ai-insider-alerts.keep.tile-support', 'Support')}
          value={formatCount(figures.support)}
          detail={t('ai-insider-alerts.keep.tile-support-detail', '{{tech}} technical · {{deactivated}} deactivated', {
            tech: formatCount(figures.supportTech),
            deactivated: formatCount(figures.supportDeactivated),
          })}
        />
        <Tile
          label={t('ai-insider-alerts.keep.tile-control', 'Control group')}
          value={formatCount(figures.control)}
          detail={t('ai-insider-alerts.keep.tile-control-detail', 'MDE ≈ {{mde}} pp · {{share}} held out', {
            mde: snapshot.mdePct === null ? '—' : snapshot.mdePct.toFixed(1),
            share: pctText(rules.holdoutShare),
          })}
        />
        <Tile
          label={t('ai-insider-alerts.keep.tile-ga4', 'GA4 evidence')}
          value={behaviorText(quality.behavior)}
          detail={behaviorDetail(quality.behavior)}
        />
      </div>

      <div className={styles.tabsRow}>
        <TabsBar className={styles.tabs}>
          <Tab
            label={t('ai-insider-alerts.keep.tab-jobs', 'Jobs')}
            counter={snapshot.jobs.length}
            active={tab === 'jobs'}
            onChangeTab={() => setTab('jobs')}
          />
          <Tab
            label={t('ai-insider-alerts.keep.tab-renewals', 'Renewals')}
            counter={snapshot.renewals.length}
            active={tab === 'renewals'}
            onChangeTab={() => setTab('renewals')}
          />
          <Tab
            label={t('ai-insider-alerts.keep.tab-leads', 'Leads')}
            counter={snapshot.leads.length}
            active={tab === 'leads'}
            onChangeTab={() => setTab('leads')}
          />
          <Tab
            label={t('ai-insider-alerts.keep.tab-support', 'Support')}
            counter={snapshot.support.length}
            active={tab === 'support'}
            onChangeTab={() => setTab('support')}
          />
          <Tab
            label={t('ai-insider-alerts.keep.tab-quality', 'Quality')}
            active={tab === 'quality'}
            onChangeTab={() => setTab('quality')}
          />
          {snapshot.backtest && (
            <Tab
              label={t('ai-insider-alerts.keep.tab-backtest', 'Backtest')}
              counter={snapshot.backtest.asOfs.length}
              active={tab === 'backtest'}
              onChangeTab={() => setTab('backtest')}
            />
          )}
        </TabsBar>
      </div>

      <div className={styles.tabBody}>
        {tab === 'jobs' && (
          <JobsTab
            snapshot={snapshot}
            rules={rules}
            byKey={byKey}
            includeTitles={includeTitles}
            onIncludeTitlesChange={onIncludeTitlesChange}
            onExport={onExport}
          />
        )}
        {tab === 'renewals' && <RenewalsTab renewals={snapshot.renewals} controlKeys={controlKeys} />}
        {(tab === 'leads' || tab === 'support') && (
          <AccountsTab
            // A new list starts with an empty search.
            key={tab}
            kind={tab}
            rows={tab === 'leads' ? snapshot.leads : snapshot.support}
            rules={rules}
            asOf={snapshot.asOf}
            controlKeys={controlKeys}
            includeTitles={includeTitles}
            onExport={onExport}
          />
        )}
        {tab === 'quality' && (
          <QualityTab snapshot={snapshot} overrides={planClassOverrides} onPlanClassChange={onPlanClassChange} />
        )}
        {tab === 'backtest' && snapshot.backtest && <BacktestTab report={snapshot.backtest} />}
      </div>
    </div>
  );
}

function JobsTab({
  snapshot,
  rules,
  byKey,
  includeTitles,
  onIncludeTitlesChange,
  onExport,
}: {
  snapshot: KeepSnapshot;
  rules: KeepRules;
  byKey: Map<string, AccountAssessment>;
  includeTitles: boolean;
  onIncludeTitlesChange: (include: boolean) => void;
  onExport?: (kind: ExportKind, rows: number) => void;
}) {
  const styles = useStyles2(getResultsStyles);
  const own = useStyles2(getKeepStyles);
  const [action, setAction] = useState<KeepAction | 'all'>('all');
  const [delivery, setDelivery] = useState<Delivery | 'all'>('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string>();
  const [confirm, setConfirm] = useState<ExportKind>();

  const sorted = useMemo(() => [...snapshot.jobs].sort((a, b) => b.priority - a.priority), [snapshot.jobs]);
  const filtered = useMemo(() => {
    const match = accountMatcher(search);
    return sorted.filter(
      (j) =>
        (action === 'all' || j.action === action) &&
        (delivery === 'all' || j.delivery === delivery) &&
        (!match || match(j.account, j.accountKey))
    );
  }, [sorted, action, delivery, search]);
  const toExport = useMemo(() => marketingJobs(filtered), [filtered]);
  const controlCount = useMemo(() => snapshot.jobs.filter((j) => j.control).length, [snapshot.jobs]);

  const actionOptions: Array<{ label: string; value: KeepAction | 'all' }> = [
    { label: t('ai-insider-alerts.keep.filter-all', 'All'), value: 'all' },
    ...ACTIONS.map((a) => ({ label: actionText(a), value: a })),
  ];
  const deliveryOptions: Array<{ label: string; value: Delivery | 'all' }> = [
    { label: t('ai-insider-alerts.keep.filter-any-channel', 'Any channel'), value: 'all' },
    ...DELIVERIES.map((d) => ({ label: deliveryText(d), value: d })),
  ];

  const save = () => {
    if (confirm === 'jobs') {
      downloadJobsCsv(snapshot.asOf, toExport, {
        includeTitles,
        tzOffsetOf: (key) => byKey.get(key)?.tzOffsetH,
      });
      onExport?.('jobs', toExport.length);
    } else if (confirm === 'control') {
      downloadControlJson(snapshot, rules);
      onExport?.('control', controlCount);
    }
    setConfirm(undefined);
  };

  return (
    <>
      <div className={styles.toolbar}>
        <RadioButtonGroup size="sm" options={actionOptions} value={action} onChange={setAction} />
        <RadioButtonGroup size="sm" options={deliveryOptions} value={delivery} onChange={setDelivery} />
        <AccountSearch value={search} onChange={setSearch} />
      </div>
      <div className={styles.toolbar}>
        <Button
          size="sm"
          variant="secondary"
          icon="download-alt"
          disabled={!toExport.length}
          onClick={() => setConfirm('jobs')}
          tooltip={t(
            'ai-insider-alerts.keep.export-jobs-tip',
            'The jobs of the current filter for marketing: never the control group, never support hand-offs. Deferred jobs (beyond the daily capacity, no send time) and jobs without a channel are included and marked in the deferred and delivery columns'
          )}
        >
          {t('ai-insider-alerts.keep.export-jobs', 'Export jobs CSV ({{rows}})', {
            rows: formatCount(toExport.length),
          })}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon="download-alt"
          disabled={!controlCount}
          onClick={() => setConfirm('control')}
          tooltip={t(
            'ai-insider-alerts.keep.export-control-tip',
            'The whole control group of this scan: never contact them; compare their outcome with the jobs later'
          )}
        >
          {t('ai-insider-alerts.keep.export-control', 'Export control JSON ({{rows}})', {
            rows: formatCount(controlCount),
          })}
        </Button>
        <Checkbox
          label={t('ai-insider-alerts.keep.include-titles', 'Include titles')}
          description={t('ai-insider-alerts.keep.include-titles-desc', 'Seed titles next to their ids in the CSV')}
          value={includeTitles}
          onChange={(e) => onIncludeTitlesChange(e.currentTarget.checked)}
        />
      </div>
      <ExportConfirm isOpen={confirm !== undefined} onConfirm={save} onDismiss={() => setConfirm(undefined)} />

      {!filtered.length ? (
        <p className={styles.empty}>
          {snapshot.jobs.length ? (
            <Trans i18nKey="ai-insider-alerts.keep.no-jobs-filter">No job matches the filter.</Trans>
          ) : (
            <Trans i18nKey="ai-insider-alerts.keep.no-jobs">
              No customer at risk on this day by the current rules.
            </Trans>
          )}
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>
                  <Trans i18nKey="ai-insider-alerts.keep.col-account">Account</Trans>
                </th>
                <th>
                  <Trans i18nKey="ai-insider-alerts.keep.col-why">Why</Trans>
                </th>
                <th>
                  <Trans i18nKey="ai-insider-alerts.keep.col-action">Action</Trans>
                </th>
                <th>
                  <Trans i18nKey="ai-insider-alerts.keep.col-send">Send (UTC)</Trans>
                </th>
                <th>
                  <Trans i18nKey="ai-insider-alerts.keep.col-delivery">Delivery</Trans>
                </th>
                <th className={styles.num}>
                  <Trans i18nKey="ai-insider-alerts.keep.col-priority">Priority</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, LIST_LIMIT).map((job) => {
                const open = expanded === job.id;
                const toggle = () => setExpanded(open ? undefined : job.id);
                const assessment = byKey.get(job.key);
                const tz = assessment?.tzOffsetH ?? null;
                const local = localTime(job.sendAt, tz);
                const offer = offerText(job.offerKind, job.offerTool, job.offerStep);
                return (
                  <Fragment key={job.id}>
                    <tr className={cx(styles.clickable, open && styles.rowOpen)} onClick={toggle}>
                      <td className={styles.mono}>
                        <RowToggle open={open} label={rowLabel(job.account)} onToggle={toggle} />
                        {job.account}
                        <span className={styles.sub}>
                          {job.pid} · {job.plan || '—'}
                        </span>
                      </td>
                      <td className={own.why}>
                        {evidenceSentence(job.evidence, 3, evidenceContext(assessment, rules))}
                        <span className={styles.sub}>
                          {reasonText(job.reason)}
                          {job.techIssue ? ` · ${t('ai-insider-alerts.keep.tech-issue', 'technical issue')}` : ''}
                        </span>
                      </td>
                      <td>
                        <Badge text={actionText(job.action)} color={actionColor(job.action)} />
                        {offer && <span className={styles.sub}>{offer}</span>}
                        {job.steps.length > 1 && (
                          <span className={styles.sub}>
                            {t('ai-insider-alerts.keep.steps-count', '{{steps}} steps', { steps: job.steps.length })}
                          </span>
                        )}
                      </td>
                      <td>
                        {job.sendAt === null ? (
                          <Trans i18nKey="ai-insider-alerts.keep.any-time">any time</Trans>
                        ) : (
                          formatUtc(job.sendAt)
                        )}
                        {local && tz !== null && (
                          <span className={styles.sub}>
                            {t('ai-insider-alerts.keep.local-time', '{{time}} local ({{offset}})', {
                              time: local,
                              offset: utcOffsetLabel(tz),
                              ...RAW,
                            })}
                          </span>
                        )}
                        {job.dueBy !== null && (
                          <span className={styles.sub}>
                            {t('ai-insider-alerts.keep.due-by', 'due {{due}}', { due: formatUtc(job.dueBy) })}
                          </span>
                        )}
                      </td>
                      <td>
                        <Badge text={deliveryText(job.delivery)} color={deliveryColor(job.delivery)} />
                      </td>
                      <td className={styles.num}>
                        {job.priority}
                        <span className={cx(styles.flags, own.right)}>
                          {job.control ? (
                            <Badge
                              text={t('ai-insider-alerts.keep.control', 'Control')}
                              color="darkgrey"
                              tooltip={t(
                                'ai-insider-alerts.keep.control-tip',
                                'In the control group: never contacted, to measure the effect'
                              )}
                            />
                          ) : (
                            <Badge text={tierText(job.tier)} color={tierColor(job.tier)} />
                          )}
                          {job.deferred && (
                            <Badge
                              text={t('ai-insider-alerts.keep.deferred', 'Deferred')}
                              color="darkgrey"
                              tooltip={t(
                                'ai-insider-alerts.keep.deferred-tip',
                                'Beyond the daily capacity of this action: for a later day'
                              )}
                            />
                          )}
                        </span>
                      </td>
                    </tr>
                    {open && (
                      <tr className={styles.detailRow}>
                        <td colSpan={6}>
                          <JobDetails job={job} assessment={assessment} rules={rules} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {filtered.length > LIST_LIMIT && (
        <div className={styles.legend}>
          {toExport.length === filtered.length
            ? t('ai-insider-alerts.keep.list-truncated', 'Showing {{shown}} of {{total}}. Export the CSV for all.', {
                shown: LIST_LIMIT,
                total: formatCount(filtered.length),
              })
            : t(
                'ai-insider-alerts.keep.list-truncated-csv',
                'Showing {{shown}} of {{total}}. The CSV holds {{csv}} of them (no control, no support).',
                {
                  shown: LIST_LIMIT,
                  total: formatCount(filtered.length),
                  csv: formatCount(toExport.length),
                }
              )}
        </div>
      )}
    </>
  );
}

function JobDetails({
  job,
  assessment,
  rules,
}: {
  job: KeepJob;
  assessment: AccountAssessment | undefined;
  rules: KeepRules;
}) {
  const styles = useStyles2(getResultsStyles);
  return (
    <div className={styles.details}>
      {assessment && <AccountDetails assessment={assessment} rules={rules} />}
      <div className={styles.detailGrid}>
        <div>
          <div className={styles.detailLabel}>
            <Trans i18nKey="ai-insider-alerts.keep.detail-action">Action</Trans>
          </div>
          {jobActionText(job)}
          <div className={styles.sub}>
            {t(
              'ai-insider-alerts.keep.detail-priority',
              'priority {{priority}} = severity {{severity}} · urgency {{urgency}} · value {{value}}',
              {
                priority: job.priority,
                severity: job.priorityParts.severity.toFixed(2),
                urgency: job.priorityParts.urgency.toFixed(2),
                value: job.priorityParts.value.toFixed(2),
              }
            )}
          </div>
          {job.steps.map((s) => (
            <div key={`${s.at}-${s.what}`} className={styles.sub}>
              {formatUtc(s.at)} · {deliveryText(s.channel)} · {stepText(s.what)}
            </div>
          ))}
        </div>
        <div>
          <div className={styles.detailLabel}>
            <Trans i18nKey="ai-insider-alerts.keep.detail-recommend">Recommendations start from</Trans>
          </div>
          {job.seeds.length ? (
            job.seeds.map((s) => (
              <div key={`${s.profileId}-${s.contentType}-${s.contentId}`}>
                {s.title || s.contentId}
                <span className={styles.sub}>
                  {t('ai-insider-alerts.keep.seed-detail', '{{type}} {{id}} · {{minutes}} min · profile {{profile}}', {
                    type: s.contentType,
                    id: s.contentId,
                    minutes: Math.round(s.minutes),
                    profile: s.profileId,
                    ...RAW,
                  })}
                </span>
              </div>
            ))
          ) : (
            <span className={styles.sub}>
              <Trans i18nKey="ai-insider-alerts.keep.no-seeds">
                No seeds: the provider&apos;s most viewed instead.
              </Trans>
            </span>
          )}
          <div className={styles.sub}>
            {t('ai-insider-alerts.keep.rec-endpoint', 'catalogue: {{endpoint}} · profiles: {{profiles}}', {
              endpoint: job.recEndpoint,
              profiles: job.profileIds.join(', ') || '—',
              ...RAW,
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function stepText(what: KeepJob['steps'][number]['what']): string {
  switch (what) {
    case 'reminder':
      return t('ai-insider-alerts.keep.step-reminder', 'reminder');
    case 'payment_link':
      return t('ai-insider-alerts.keep.step-payment-link', 'payment link');
    default:
      return t('ai-insider-alerts.keep.step-content', 'content');
  }
}

/** Watch-time sparkline, recent window vs baseline, subscription and GA4 evidence of one account. */
function AccountDetails({ assessment: a, rules }: { assessment: AccountAssessment; rules: KeepRules }) {
  const styles = useStyles2(getResultsStyles);
  const own = useStyles2(getKeepStyles);
  const days = a.dailyWatch.length;
  const w = 600;
  const h = 48;
  const bw = w / Math.max(1, days);
  const max = Math.max(1, ...a.dailyWatch);
  const recentFrom = Math.max(0, days - ruleDays(rules.recentDays));
  const behavior = a.behavior;
  const context = evidenceContext(a, rules);

  return (
    <>
      {days > 0 && (
        <>
          <svg viewBox={`0 0 ${w} ${h}`} className={styles.spark} preserveAspectRatio="none" aria-hidden>
            {a.dailyWatch.map((v, i) => {
              const bh = v > 0 ? Math.max(1, (v / max) * (h - 4)) : 0;
              return (
                <rect
                  key={i}
                  x={i * bw + 1}
                  y={h - bh}
                  width={Math.max(1, bw - 2)}
                  height={bh}
                  className={i >= recentFrom ? own.barRecent : own.barBaseline}
                />
              );
            })}
            <line x1={recentFrom * bw} x2={recentFrom * bw} y1={0} y2={h} className={own.divider} />
          </svg>
          <div className={styles.legend}>
            {t(
              'ai-insider-alerts.keep.spark-legend',
              'Watched minutes per UTC day, last {{days}} days (peak {{max}} min). Right of the line: the recent window.',
              { days, max: Math.round(max) }
            )}
          </div>
        </>
      )}
      <div className={styles.detailGrid}>
        <WindowTable recent={a.recent} baseline={a.baseline} rules={rules} />
        <div>
          <div className={styles.detailLabel}>
            <Trans i18nKey="ai-insider-alerts.keep.detail-subscription">Subscription</Trans>
          </div>
          {a.latestPlan || a.baselinePlan || '—'}
          <span className={styles.sub}>
            {t('ai-insider-alerts.keep.detail-plan', '{{class}} · renewals: {{style}}', {
              class: planClassText(a.planClass),
              style: styleText(a.renewalStyle),
              ...RAW,
            })}
          </span>
          <span className={styles.sub}>
            {a.noEnd
              ? t('ai-insider-alerts.keep.detail-no-end', 'no end date')
              : a.expiry === null
                ? t('ai-insider-alerts.keep.detail-expiry-unknown', 'end unknown')
                : t('ai-insider-alerts.keep.detail-expiry', 'ends {{at}} UTC', { at: formatUtc(a.expiry) })}
          </span>
          <span className={styles.sub}>
            {t('ai-insider-alerts.keep.detail-seen', 'last seen {{at}} UTC · {{platforms}} · {{coverage}}', {
              at: formatUtc(a.lastSeen),
              platforms: a.platforms.join(', ') || '—',
              coverage: coverageText(a.signalCoverage),
              ...RAW,
            })}
          </span>
          {a.topErrCode && (
            <span className={styles.sub}>
              {t('ai-insider-alerts.keep.detail-top-code', 'top error code {{code}}', { code: a.topErrCode, ...RAW })}
            </span>
          )}
        </div>
        <div>
          <div className={styles.detailLabel}>
            <Trans i18nKey="ai-insider-alerts.keep.detail-evidence">Evidence</Trans>
          </div>
          {a.evidence.length ? (
            a.evidence.map((e, i) => <div key={`${e.code}-${i}`}>{evidenceSentence([e], 1, context)}</div>)
          ) : (
            <span className={styles.sub}>—</span>
          )}
          {behavior && (
            <span className={styles.sub}>
              {t(
                'ai-insider-alerts.keep.detail-ga4',
                'GA4, {{days}} d: {{sessions}} sessions · {{engagement}} min · {{searchNoPlay}} searches without play · {{crashes}} crashes · {{errorScreens}} error screens',
                {
                  days: behavior.days,
                  sessions: behavior.sessions,
                  engagement: Math.round(behavior.engagementMin),
                  searchNoPlay: behavior.searchNoPlaySessions,
                  crashes: behavior.crashes,
                  errorScreens: behavior.errorScreenSessions,
                }
              )}
            </span>
          )}
        </div>
      </div>
    </>
  );
}

function coverageText(coverage: AccountAssessment['signalCoverage']): string {
  switch (coverage) {
    case 'full':
      return t('ai-insider-alerts.keep.coverage-full', 'apps with analytics');
    case 'mixed':
      return t('ai-insider-alerts.keep.coverage-mixed', 'apps and set-top boxes');
    default:
      return t('ai-insider-alerts.keep.coverage-legacy', 'set-top boxes / old apps only');
  }
}

/** Recent window against the baseline: sums for counts, per day for volumes. */
function WindowTable({
  recent: r,
  baseline: b,
  rules,
}: {
  recent: WindowStats;
  baseline: WindowStats;
  rules: KeepRules;
}) {
  const styles = useStyles2(getResultsStyles);
  // The window lengths the engine used.
  const rd = ruleDays(rules.recentDays);
  const bd = ruleDays(rules.baselineDays);
  const rows: Array<[string, string, string]> = [
    [t('ai-insider-alerts.keep.sig-active', 'Active days'), `${r.activeDays}/${rd}`, `${b.activeDays}/${bd}`],
    [t('ai-insider-alerts.keep.sig-watch', 'Watched min/day'), perDay(r.watchAllMin, rd), perDay(b.watchAllMin, bd)],
    [
      t('ai-insider-alerts.keep.sig-plays', 'Plays/day'),
      perDay(r.gatedPlays + r.ungatedPlays, rd),
      perDay(b.gatedPlays + b.ungatedPlays, bd),
    ],
    [
      t('ai-insider-alerts.keep.sig-distinct', 'Titles per active day'),
      r.distinctPerDay.toFixed(1),
      b.distinctPerDay.toFixed(1),
    ],
    [
      t('ai-insider-alerts.keep.sig-failed', 'Failed / playbacks'),
      `${r.failedPlaybacks}/${r.playbacks}`,
      `${b.failedPlaybacks}/${b.playbacks}`,
    ],
    [t('ai-insider-alerts.keep.sig-buffering', 'Buffering stops'), String(r.bufferingStops), String(b.bufferingStops)],
    [
      t('ai-insider-alerts.keep.sig-inactive', 'Refused: not active'),
      String(r.inactiveAttempts),
      String(b.inactiveAttempts),
    ],
    [
      t('ai-insider-alerts.keep.sig-premium', 'Refused: other package'),
      String(r.premiumAttempts - r.premiumPaidContent),
      String(b.premiumAttempts - b.premiumPaidContent),
    ],
    [
      t('ai-insider-alerts.keep.sig-search', 'Searches opening nothing'),
      `${r.failedSearchSessions}/${r.searchSessions}`,
      `${b.failedSearchSessions}/${b.searchSessions}`,
    ],
    [
      t('ai-insider-alerts.keep.sig-favourites', 'Favourites + / −'),
      `${r.favAdded} / ${r.favRemoved}`,
      `${b.favAdded} / ${b.favRemoved}`,
    ],
    [t('ai-insider-alerts.keep.sig-app-starts', 'App starts/day'), perDay(r.appStarts, rd), perDay(b.appStarts, bd)],
  ];
  return (
    <table className={cx(styles.table, styles.innerTable)}>
      <thead>
        <tr>
          <th>
            <Trans i18nKey="ai-insider-alerts.keep.col-signal">Signal</Trans>
          </th>
          <th className={styles.num}>{t('ai-insider-alerts.keep.col-recent', 'Recent {{days}} d', { days: rd })}</th>
          <th className={styles.num}>
            {t('ai-insider-alerts.keep.col-baseline', 'Baseline {{days}} d', { days: bd })}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, recent, baseline]) => (
          <tr key={label}>
            <td>{label}</td>
            <td className={styles.num}>{recent}</td>
            <td className={styles.num}>{baseline}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RenewalsTab({ renewals, controlKeys }: { renewals: RenewalItem[]; controlKeys: Set<string> }) {
  const styles = useStyles2(getResultsStyles);
  const [expanded, setExpanded] = useState<number>();
  const [search, setSearch] = useState('');

  const { days, silent } = useMemo(() => {
    const byDay = new Map<
      number,
      { day: number; atRisk: number; autopay: number; styles: Record<RenewalStyle, number>; items: RenewalItem[] }
    >();
    const silentItems: RenewalItem[] = [];
    for (const r of renewals) {
      if (r.kind === 'expired_silent') {
        silentItems.push(r);
        continue;
      }
      const day = Math.floor(r.expiry / DAY) * DAY;
      let row = byDay.get(day);
      if (!row) {
        row = { day, atRisk: 0, autopay: 0, styles: { repurchase: 0, early: 0, at_term: 0, unknown: 0 }, items: [] };
        byDay.set(day, row);
      }
      if (r.kind === 'at_risk') {
        row.atRisk++;
      } else {
        row.autopay++;
      }
      row.styles[r.renewalStyle]++;
      row.items.push(r);
    }
    return {
      days: [...byDay.values()].sort((a, b) => a.day - b.day),
      silent: silentItems.sort((a, b) => b.expiry - a.expiry),
    };
  }, [renewals]);
  // A search lists the matching customers of every day and of "expired and silent" at once.
  const matches = useMemo(() => {
    const match = accountMatcher(search);
    return match ? renewals.filter((r) => match(r.account)) : null;
  }, [renewals, search]);

  if (!renewals.length) {
    return (
      <p className={styles.empty}>
        <Trans i18nKey="ai-insider-alerts.keep.no-renewals">No known subscription ends soon or ended lately.</Trans>
      </p>
    );
  }

  return (
    <>
      <div className={styles.legend}>
        <Trans i18nKey="ai-insider-alerts.keep.renewals-legend">
          Subscriptions ending soon, by day (UTC) and how the customer renewed last time. At risk: has a job, see the
          Jobs tab for its action; customers in the control group are marked and must not be contacted. Check autopay:
          renewed on time before and watching as usual; no job, but worth a look in the CRM. Click a day for its
          customers.
        </Trans>
      </div>
      <div className={styles.toolbar}>
        <AccountSearch value={search} onChange={setSearch} />
      </div>
      {matches !== null &&
        (matches.length ? (
          <RenewalList items={matches} controlKeys={controlKeys} />
        ) : (
          <p className={styles.empty}>
            <Trans i18nKey="ai-insider-alerts.keep.no-search-match">No customer matches the search.</Trans>
          </p>
        ))}
      {matches === null && days.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>
                  <Trans i18nKey="ai-insider-alerts.keep.col-ends">Ends (UTC)</Trans>
                </th>
                <th className={styles.num}>
                  <Trans i18nKey="ai-insider-alerts.keep.col-at-risk">At risk</Trans>
                </th>
                <th className={styles.num}>
                  <Trans i18nKey="ai-insider-alerts.keep.col-check-autopay">Check autopay</Trans>
                </th>
                {STYLES.map((s) => (
                  <th key={s} className={styles.num}>
                    {styleText(s)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((row) => {
                const open = expanded === row.day;
                const toggle = () => setExpanded(open ? undefined : row.day);
                return (
                  <Fragment key={row.day}>
                    <tr className={cx(styles.clickable, open && styles.rowOpen)} onClick={toggle}>
                      <td>
                        <RowToggle
                          open={open}
                          label={t('ai-insider-alerts.keep.day-details', 'Customers ending on {{day}}', {
                            day: isoDay(row.day),
                          })}
                          onToggle={toggle}
                        />
                        {isoDay(row.day)}
                      </td>
                      <td className={styles.num}>{row.atRisk}</td>
                      <td className={styles.num}>{row.autopay}</td>
                      {STYLES.map((s) => (
                        <td key={s} className={styles.num}>
                          {row.styles[s] || ''}
                        </td>
                      ))}
                    </tr>
                    {open && (
                      <tr className={styles.detailRow}>
                        <td colSpan={3 + STYLES.length}>
                          <RenewalList items={row.items} controlKeys={controlKeys} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {matches === null && silent.length > 0 && (
        <>
          <div className={styles.legend}>
            <Trans i18nKey="ai-insider-alerts.keep.silent-legend">
              Expired, no renewal seen: the subscription ended and no app that reports subscriptions was used since (the
              customer is silent or watches only on a set-top box). That cannot tell &quot;left&quot; from
              &quot;renewed&quot;: check them in the CRM.
            </Trans>
          </div>
          <RenewalList items={silent} controlKeys={controlKeys} />
        </>
      )}
    </>
  );
}

function RenewalList({ items, controlKeys }: { items: RenewalItem[]; controlKeys: Set<string> }) {
  const styles = useStyles2(getResultsStyles);
  return (
    <>
      <table className={cx(styles.table, styles.innerTable)}>
        <thead>
          <tr>
            <th>
              <Trans i18nKey="ai-insider-alerts.keep.col-account">Account</Trans>
            </th>
            <th>
              <Trans i18nKey="ai-insider-alerts.keep.col-plan">Provider · plan</Trans>
            </th>
            <th>
              <Trans i18nKey="ai-insider-alerts.keep.col-ends">Ends (UTC)</Trans>
            </th>
            <th>
              <Trans i18nKey="ai-insider-alerts.keep.col-style">Last renewal</Trans>
            </th>
            <th>
              <Trans i18nKey="ai-insider-alerts.keep.col-kind">Kind</Trans>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.slice(0, LIST_LIMIT).map((r) => {
            const badge = renewalKindBadge(r.kind);
            return (
              <tr key={r.key}>
                <td className={styles.mono}>{r.account}</td>
                <td>
                  {r.pid} · {r.plan || '—'}
                </td>
                <td>{formatUtc(r.expiry)}</td>
                <td>{styleText(r.renewalStyle)}</td>
                <td>
                  <span className={styles.flags}>
                    <Badge text={badge.text} color={badge.color} />
                    {controlKeys.has(r.key) && <ControlBadge />}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {items.length > LIST_LIMIT && (
        <div className={styles.sub}>
          {t('ai-insider-alerts.keep.more-customers', '…and {{more}} more', {
            more: formatCount(items.length - LIST_LIMIT),
          })}
        </div>
      )}
    </>
  );
}

/** Upsell leads or support hand-offs: one row per account, in the engine's order (worst first). */
function AccountsTab({
  kind,
  rows,
  rules,
  asOf,
  controlKeys,
  includeTitles,
  onExport,
}: {
  kind: 'leads' | 'support';
  rows: AccountAssessment[];
  rules: KeepRules;
  asOf: number;
  controlKeys: Set<string>;
  includeTitles: boolean;
  onExport?: (kind: ExportKind, rows: number) => void;
}) {
  const styles = useStyles2(getResultsStyles);
  const own = useStyles2(getKeepStyles);
  const [expanded, setExpanded] = useState<string>();
  const [search, setSearch] = useState('');
  const [confirm, setConfirm] = useState(false);

  const filtered = useMemo(() => {
    const match = accountMatcher(search);
    return match ? rows.filter((a) => match(a.account, a.accountKey)) : rows;
  }, [rows, search]);
  // Support is no marketing contact: all of it goes to the file, the control group marked. A sales call is one.
  const toExport = useMemo(
    () => (kind === 'leads' ? salesLeads(filtered, controlKeys) : filtered),
    [kind, filtered, controlKeys]
  );

  if (!rows.length) {
    return (
      <p className={styles.empty}>
        {kind === 'leads' ? (
          <Trans i18nKey="ai-insider-alerts.keep.no-leads">
            Nobody with an active subscription kept hitting content of another package.
          </Trans>
        ) : (
          <Trans i18nKey="ai-insider-alerts.keep.no-support">
            No customer with repeated playback problems or a deactivated subscription.
          </Trans>
        )}
      </p>
    );
  }

  const save = () => {
    if (kind === 'support') {
      downloadSupportCsv(asOf, toExport, { rules, controlKeys });
    } else {
      downloadLeadsCsv(asOf, toExport, { rules, controlKeys, includeTitles });
    }
    onExport?.(kind, toExport.length);
    setConfirm(false);
  };

  return (
    <>
      <div className={styles.legend}>
        {kind === 'leads' ? (
          <Trans i18nKey="ai-insider-alerts.keep.leads-legend">
            Active subscribers who tried content of another package and watch as usual: an upgrade lead for sales, not a
            risk. Pay-per-view titles never count.
          </Trans>
        ) : (
          <Trans i18nKey="ai-insider-alerts.keep.support-legend">
            Customers with repeated failed playbacks or buffering (more than usual for them, on several days), and
            subscriptions that were deactivated (void, refund or admin). A hand-off to support and Tell the customer:
            marketing promotions to them are held back.
          </Trans>
        )}
      </div>
      <div className={styles.toolbar}>
        <AccountSearch value={search} onChange={setSearch} />
        <Button
          size="sm"
          variant="secondary"
          icon="download-alt"
          disabled={!toExport.length}
          onClick={() => setConfirm(true)}
          tooltip={
            kind === 'leads'
              ? t(
                  'ai-insider-alerts.keep.export-leads-tip',
                  'The leads of the current search for sales: never the control group. The refused title only with "Include titles" on the Jobs tab'
                )
              : t(
                  'ai-insider-alerts.keep.export-support-tip',
                  'The customers of the current search for support: reason codes, failure figures of the recent window, deactivation, platforms; the control group is included and marked'
                )
          }
        >
          {kind === 'leads'
            ? t('ai-insider-alerts.keep.export-leads', 'Export leads CSV ({{rows}})', {
                rows: formatCount(toExport.length),
              })
            : t('ai-insider-alerts.keep.export-support', 'Export support CSV ({{rows}})', {
                rows: formatCount(toExport.length),
              })}
        </Button>
      </div>
      <ExportConfirm isOpen={confirm} onConfirm={save} onDismiss={() => setConfirm(false)} />

      {!filtered.length ? (
        <p className={styles.empty}>
          <Trans i18nKey="ai-insider-alerts.keep.no-search-match">No customer matches the search.</Trans>
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>
                  <Trans i18nKey="ai-insider-alerts.keep.col-account">Account</Trans>
                </th>
                <th>
                  <Trans i18nKey="ai-insider-alerts.keep.col-why">Why</Trans>
                </th>
                <th className={styles.num}>
                  {kind === 'leads' ? (
                    <Trans i18nKey="ai-insider-alerts.keep.col-refused">Refused (other package)</Trans>
                  ) : (
                    <Trans i18nKey="ai-insider-alerts.keep.col-failed">Failed / playbacks</Trans>
                  )}
                </th>
                <th className={styles.num}>
                  <Trans i18nKey="ai-insider-alerts.keep.col-watch">Watched min/day</Trans>
                </th>
                <th>
                  <Trans i18nKey="ai-insider-alerts.keep.col-platforms">Platforms</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, LIST_LIMIT).map((a) => {
                const open = expanded === a.key;
                const toggle = () => setExpanded(open ? undefined : a.key);
                return (
                  <Fragment key={a.key}>
                    <tr className={cx(styles.clickable, open && styles.rowOpen)} onClick={toggle}>
                      <td className={styles.mono}>
                        <RowToggle open={open} label={rowLabel(a.account)} onToggle={toggle} />
                        {a.account}
                        <span className={styles.sub}>
                          {a.pid} · {a.latestPlan || a.baselinePlan || '—'}
                        </span>
                        {controlKeys.has(a.key) && <ControlBadge support={kind === 'support'} />}
                      </td>
                      <td className={own.why}>{evidenceSentence(a.evidence, 3, evidenceContext(a, rules)) || '—'}</td>
                      <td className={styles.num}>
                        {kind === 'leads'
                          ? a.recent.premiumAttempts - a.recent.premiumPaidContent
                          : `${a.recent.failedPlaybacks}/${a.recent.playbacks}`}
                        {kind === 'support' && a.topErrCode && <span className={styles.sub}>{a.topErrCode}</span>}
                      </td>
                      <td className={styles.num}>
                        {perDay(a.recent.watchAllMin, ruleDays(rules.recentDays))}
                        <span className={styles.sub}>
                          {t('ai-insider-alerts.keep.was-per-day', 'was {{value}}', {
                            value: perDay(a.baseline.watchAllMin, ruleDays(rules.baselineDays)),
                          })}
                        </span>
                      </td>
                      <td>{a.platforms.join(', ') || '—'}</td>
                    </tr>
                    {open && (
                      <tr className={styles.detailRow}>
                        <td colSpan={5}>
                          <div className={styles.details}>
                            <AccountDetails assessment={a} rules={rules} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {filtered.length > LIST_LIMIT && (
        <div className={styles.legend}>
          {toExport.length === filtered.length
            ? t(
                'ai-insider-alerts.keep.list-limited',
                'Showing {{shown}} of {{total}}. Search an account, or export the CSV for all.',
                {
                  shown: LIST_LIMIT,
                  total: formatCount(filtered.length),
                }
              )
            : t(
                'ai-insider-alerts.keep.list-limited-csv',
                'Showing {{shown}} of {{total}}. Search an account; the CSV holds {{csv}} of them (no control).',
                {
                  shown: LIST_LIMIT,
                  total: formatCount(filtered.length),
                  csv: formatCount(toExport.length),
                }
              )}
        </div>
      )}
    </>
  );
}

function QualityTab({
  snapshot,
  overrides,
  onPlanClassChange,
}: {
  snapshot: KeepSnapshot;
  overrides: Record<string, PlanClass>;
  onPlanClassChange: (pid: string, plan: string, cls: PlanClass | undefined) => void;
}) {
  const styles = useStyles2(getResultsStyles);
  const { quality } = snapshot;
  const [pidFilter, setPidFilter] = useState('');
  const coverage = useMemo(() => {
    const counts = { full: 0, mixed: 0, legacy_only: 0 };
    snapshot.assessments.forEach((a) => counts[a.signalCoverage]++);
    return counts;
  }, [snapshot.assessments]);
  const full = quality.days.filter((d) => d.level === 'full').length;
  const plans = useMemo(
    () => [...quality.plans].sort((a, b) => (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : b.accounts - a.accounts)),
    [quality.plans]
  );
  const shownPlans = useMemo(() => {
    const q = pidFilter.trim();
    return q ? plans.filter((p) => p.pid.startsWith(q)) : plans;
  }, [plans, pidFilter]);
  const classOptions: Array<{ label: string; value: PlanClass | 'auto' }> = [
    { label: t('ai-insider-alerts.keep.plan-auto', 'By name'), value: 'auto' },
    { label: planClassText('paid'), value: 'paid' },
    { label: planClassText('free'), value: 'free' },
    { label: planClassText('unknown'), value: 'unknown' },
  ];
  const figure = (label: string, value: number, detail: string) => (
    <div>
      <div className={styles.detailLabel}>{label}</div>
      {formatCount(value)}
      <span className={styles.sub}>{detail}</span>
    </div>
  );

  return (
    <>
      <div className={styles.detailGrid}>
        {figure(
          t('ai-insider-alerts.keep.q-accounts', 'Customers seen'),
          quality.accounts,
          t('ai-insider-alerts.keep.q-accounts-detail', '{{eligible}} judged (others new or on free plans)', {
            eligible: formatCount(quality.eligible),
          })
        )}
        {figure(
          t('ai-insider-alerts.keep.q-legacy', 'Set-top boxes / old apps only'),
          quality.legacyOnly,
          t(
            'ai-insider-alerts.keep.q-legacy-detail',
            'no watch time, errors or subscription end: judged by active days'
          )
        )}
        {figure(
          t('ai-insider-alerts.keep.q-coverage', 'Apps with analytics'),
          coverage.full,
          t('ai-insider-alerts.keep.q-coverage-detail', '{{mixed}} also on set-top boxes · {{legacy}} only on them', {
            mixed: formatCount(coverage.mixed),
            legacy: formatCount(coverage.legacy_only),
          })
        )}
        {figure(
          t('ai-insider-alerts.keep.q-plan-unknown', 'Plan unknown'),
          quality.planUnknown,
          t('ai-insider-alerts.keep.q-plan-unknown-detail', 'no plan name seen: never judged free, never a downgrade')
        )}
        {figure(
          t('ai-insider-alerts.keep.q-expiry-unknown', 'Subscription end unknown'),
          quality.expiryUnknown,
          t('ai-insider-alerts.keep.q-expiry-unknown-detail', '{{noEnd}} on plans without an end date', {
            noEnd: formatCount(quality.noEnd),
          })
        )}
        <div>
          <div className={styles.detailLabel}>
            <Trans i18nKey="ai-insider-alerts.keep.q-days">Days read</Trans>
          </div>
          {t('ai-insider-alerts.keep.q-days-value', '{{full}} full · {{light}} light', {
            full,
            light: quality.days.length - full,
          })}
          <span className={styles.sub}>
            {quality.missingDays.length
              ? t('ai-insider-alerts.keep.q-missing', 'missing: {{days}}', {
                  days: quality.missingDays.map(isoDay).join(', '),
                })
              : t('ai-insider-alerts.keep.q-none-missing', 'none missing')}
          </span>
        </div>
      </div>

      <div className={styles.legend}>
        <Trans i18nKey="ai-insider-alerts.keep.plans-legend">
          Plan classes per provider, guessed from the plan name (free, trial). Free plans are not judged unless the
          rules say so; paid to free is a downgrade. Correct a wrong guess here: it applies on the next run.
        </Trans>
      </div>
      {plans.length > 0 && (
        <div className={styles.toolbar}>
          <Input
            className={styles.search}
            prefix={<Icon name="search" />}
            placeholder={t('ai-insider-alerts.keep.plans-filter-placeholder', 'Provider')}
            aria-label={t('ai-insider-alerts.keep.plans-filter-label', 'Filter plans by provider')}
            value={pidFilter}
            onChange={(e) => setPidFilter(e.currentTarget.value)}
          />
        </div>
      )}
      {shownPlans.length ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>
                  <Trans i18nKey="ai-insider-alerts.keep.col-provider">Provider</Trans>
                </th>
                <th>
                  <Trans i18nKey="ai-insider-alerts.keep.col-plan-name">Plan</Trans>
                </th>
                <th className={styles.num}>
                  <Trans i18nKey="ai-insider-alerts.keep.col-customers">Customers</Trans>
                </th>
                <th>
                  <Trans i18nKey="ai-insider-alerts.keep.col-class">Class</Trans>
                </th>
                <th>
                  <Trans i18nKey="ai-insider-alerts.keep.col-override">Override</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {shownPlans.slice(0, LIST_LIMIT).map((p) => {
                const key = `${p.pid}|${p.plan}`;
                const name = p.plan || t('ai-insider-alerts.keep.no-plan-name', '(no plan name)');
                return (
                  <tr key={key}>
                    <td>{p.pid}</td>
                    <td>{name}</td>
                    <td className={styles.num}>{formatCount(p.accounts)}</td>
                    <td>
                      {planClassText(p.planClass)}
                      {p.overridden && (
                        <span className={styles.sub}>
                          <Trans i18nKey="ai-insider-alerts.keep.overridden">overridden</Trans>
                        </span>
                      )}
                    </td>
                    <td>
                      <div
                        role="group"
                        aria-label={t('ai-insider-alerts.keep.plan-class-group', 'Plan class of {{plan}} ({{pid}})', {
                          plan: name,
                          pid: p.pid,
                          ...RAW,
                        })}
                      >
                        <RadioButtonGroup
                          size="sm"
                          options={classOptions}
                          value={overrides[key] ?? 'auto'}
                          onChange={(v) => onPlanClassChange(p.pid, p.plan, v === 'auto' ? undefined : v)}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={styles.empty}>
          {plans.length ? (
            <Trans i18nKey="ai-insider-alerts.keep.no-plans-filter">No plan of this provider.</Trans>
          ) : (
            <Trans i18nKey="ai-insider-alerts.keep.no-plans">No plan names seen.</Trans>
          )}
        </p>
      )}
      {shownPlans.length > LIST_LIMIT && (
        <div className={styles.legend}>
          {t(
            'ai-insider-alerts.keep.plans-limited',
            'Showing {{shown}} of {{total}} plans. Filter by provider for the others.',
            {
              shown: LIST_LIMIT,
              total: formatCount(shownPlans.length),
            }
          )}
        </div>
      )}

      <div className={styles.detailGrid}>
        <div>
          <div className={styles.detailLabel}>
            <Trans i18nKey="ai-insider-alerts.keep.q-paywall">Refused playbacks by platform and code</Trans>
          </div>
          {quality.paywall.length ? (
            <table className={cx(styles.table, styles.innerTable)}>
              <thead>
                <tr>
                  <th>
                    <Trans i18nKey="ai-insider-alerts.keep.col-platform">Platform</Trans>
                  </th>
                  <th>
                    <Trans i18nKey="ai-insider-alerts.keep.col-code">Code</Trans>
                  </th>
                  <th>
                    <Trans i18nKey="ai-insider-alerts.keep.col-kind">Kind</Trans>
                  </th>
                  <th className={styles.num}>
                    <Trans i18nKey="ai-insider-alerts.keep.col-refused-count">Refused</Trans>
                  </th>
                </tr>
              </thead>
              <tbody>
                {quality.paywall.slice(0, LIST_LIMIT).map((p) => {
                  const badge = paywallKindBadge(p.kind);
                  return (
                    <tr key={`${p.platform}|${p.code}|${p.kind}`}>
                      <td>{p.platform || '—'}</td>
                      <td className={styles.mono}>{p.code || '—'}</td>
                      <td>
                        <Badge text={badge.text} color={badge.color} tooltip={badge.tooltip} />
                      </td>
                      <td className={styles.num}>{formatCount(p.count)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <span className={styles.sub}>—</span>
          )}
          <span className={styles.sub}>
            <Trans i18nKey="ai-insider-alerts.keep.q-paywall-detail">
              What each platform sends when a playback is refused (slot 10 / slot 11), recent and baseline windows.
              Codes not in the paywall definition are forms to confirm before they count as refusals.
            </Trans>
          </span>
        </div>
        <div>
          <div className={styles.detailLabel}>
            <Trans i18nKey="ai-insider-alerts.keep.q-styles">Last renewal</Trans>
          </div>
          {STYLES.map((s) => (
            <div key={s}>
              {styleText(s)}: {formatCount(quality.renewalStyles[s] ?? 0)}
            </div>
          ))}
          <span className={styles.sub}>
            <Trans i18nKey="ai-insider-alerts.keep.q-styles-detail">
              From the subscription ends the apps reported. At term may be autopay or a manual payment on time.
            </Trans>
          </span>
        </div>
        <div>
          <div className={styles.detailLabel}>
            <Trans i18nKey="ai-insider-alerts.keep.q-ga4">GA4 evidence</Trans>
          </div>
          {behaviorText(quality.behavior)}
          <span className={styles.sub}>{behaviorDetail(quality.behavior)}</span>
        </div>
      </div>
    </>
  );
}

function BacktestTab({ report }: { report: BacktestReport }) {
  const styles = useStyles2(getResultsStyles);
  return (
    <>
      <div className={styles.legend}>
        {t(
          'ai-insider-alerts.keep.backtest-head',
          'As-of dates: {{dates}} · outcome within {{days}} d · {{suppressed}} jobs suppressed by the cooldown',
          {
            dates: report.asOfs.map(isoDay).join(', '),
            days: report.horizonDays,
            suppressed: formatCount(report.suppressedByCooldown),
          }
        )}
      </div>
      {report.rows.length ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>
                  <Trans i18nKey="ai-insider-alerts.keep.col-group">Group (bad outcome)</Trans>
                </th>
                <th className={styles.num}>
                  <Trans i18nKey="ai-insider-alerts.keep.col-flagged">Flagged</Trans>
                </th>
                <th className={styles.num}>
                  <Trans i18nKey="ai-insider-alerts.keep.col-labeled">Known outcome</Trans>
                </th>
                <th className={styles.num}>
                  <Trans i18nKey="ai-insider-alerts.keep.col-censored">Censored</Trans>
                </th>
                <th className={styles.num}>
                  <Trans i18nKey="ai-insider-alerts.keep.col-positive">Bad, flagged</Trans>
                </th>
                <th className={styles.num}>
                  <Trans i18nKey="ai-insider-alerts.keep.col-base">Bad, not flagged</Trans>
                </th>
                <th className={styles.num}>
                  <Trans i18nKey="ai-insider-alerts.keep.col-lift">Lift</Trans>
                </th>
                <th className={styles.num}>
                  <Trans i18nKey="ai-insider-alerts.keep.col-recall">Recall</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.group}>
                  <td>{groupText(r.group)}</td>
                  <td className={styles.num}>{formatCount(r.flagged)}</td>
                  <td className={styles.num}>{formatCount(r.labeled)}</td>
                  <td className={styles.num}>
                    {formatCount(r.censored)}
                    <span className={styles.sub}>{pctText(r.flagged ? r.censored / r.flagged : null)}</span>
                  </td>
                  <td className={styles.num}>{pctText(r.positiveRate)}</td>
                  <td className={styles.num}>{pctText(r.baseRate)}</td>
                  <td className={styles.num}>
                    {r.lift === null
                      ? NONE
                      : t('ai-insider-alerts.keep.lift-value', '{{lift}}×', { lift: r.lift.toFixed(1) })}
                  </td>
                  <td className={styles.num}>{pctText(r.recall)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={styles.empty}>
          <Trans i18nKey="ai-insider-alerts.keep.no-backtest">Nobody was flagged on these dates.</Trans>
        </p>
      )}
      <div className={styles.legend}>
        <Trans i18nKey="ai-insider-alerts.keep.backtest-legend">
          The rules on past days against what happened next. Price and timing: the subscription was not renewed. Content
          and disengaged: watch time did not recover. Quiet only: did not come back. Lift: bad outcomes among the
          flagged divided by those among the judged but not flagged (above 1 = the rules find real risk). Recall: the
          share of all bad outcomes that were flagged. Censored: the outcome cannot be known yet (no renewal seen within
          the grace days); left out of both.
        </Trans>
      </div>
    </>
  );
}

const getKeepStyles = (theme: GrafanaTheme2) => ({
  toggle: css({
    marginRight: theme.spacing(0.5),
    verticalAlign: 'middle',
  }),
  why: css({
    color: analytix.textDim,
    minWidth: 240,
    maxWidth: 420,
  }),
  right: css({
    justifyContent: 'flex-end',
    marginTop: 2,
  }),
  barRecent: css({
    fill: analytix.green,
  }),
  barBaseline: css({
    fill: analytix.textFaint,
    opacity: 0.6,
  }),
  divider: css({
    stroke: theme.colors.text.primary,
    strokeWidth: 1,
    strokeDasharray: '3 3',
  }),
});
