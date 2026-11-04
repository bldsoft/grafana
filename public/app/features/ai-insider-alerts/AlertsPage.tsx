// Analytix: AI Insider Alerts — "tell the customer" up to (not including) the
// send step. Detects operator-side channel outages in the Analytix event
// stream, decides per viewer who would be told what and when (or deliberately
// not told), and replays past days as if they were live so the rules can be
// checked against real incidents before any message is ever sent. A second
// section, "Keep the customer" (keep/), finds subscribers drifting away and
// prepares the hand-off for marketing; both share the datasource and the
// provider scope.

import { css } from '@emotion/css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  DataSourceInstanceSettings,
  DataSourceRef,
  GrafanaTheme2,
  InternalTimeZones,
  NavModel,
  TimeRange,
  TimeZone,
  dateMath,
  dateTime,
  store,
} from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import { DataSourcePicker, getDataSourceSrv, reportInteraction } from '@grafana/runtime';
import {
  Alert,
  Badge,
  Button,
  Collapse,
  Field,
  InlineSwitch,
  Input,
  RadioButtonGroup,
  Spinner,
  Tab,
  TabsBar,
  TimeRangeInput,
  TimeZonePicker,
  useStyles2,
} from '@grafana/ui';
import { Page } from 'app/core/components/Page/Page';
import { useQueryParams } from 'app/core/hooks/useQueryParams';
import { HOME_NAV_ID } from 'app/core/reducers/navModel';
import { useAiInsiderAccessState } from 'app/features/dashboard-scene/ai-panel/useAiInsiderAccess';
import { analytix } from 'app/features/home/analytixTokens';
import { useSelector } from 'app/types/store';

import { AlertsResults, AlertsSnapshot } from './AlertsResults';
import { AlertsDatasourceContext } from './CdnCheck';
import { DayOverview } from './DayOverview';
import { SupportResults } from './SupportResults';
import { AskInsiderProvider } from './askInsider';
import { AlertEngine } from './engine';
import { ExportMeta, downloadBlob, exportFileName, exportRun, runDatasetExport } from './export';
import { formatAt, formatCount, fromUtcInput, setDisplayTimeZone, zoneLabel } from './format';
import { KeepWorkbench, datasourceName, runScopeText, scopePids } from './keep/KeepWorkbench';
import { ShareStatus, liveClientId, liveRoom, runSharedLive } from './liveShare';
import { AlertsSection as Section, RETENTION_VISIBLE, alertsSectionNavId, buildAlertsNav } from './nav';
import { HOUR_SEC, Overview, loadOverview } from './overview';
import { runLive, runReplay } from './runner';
import { ProviderScope, effectiveScope, parseProviderScope } from './scope';
import { AlertRules, DEFAULT_RULES } from './types';

const SETTINGS_KEY = 'analytix.aiAlerts.settings.v1';
/** Datasource and provider filter, shared by both sections. */
const COMMON_KEY = 'analytix.aiAlerts.common.v1';
/** true = the full view for tuning the rules; false = the support view. */
const ADVANCED_KEY = 'analytix.aiAlerts.advanced.v1';
const MAX_REPLAY_SEC = 7 * 86400;
const LIVE_POLL_MS = 60000;

/** `day`: the last 24 hours per hour, a click opens an hour as a past period (`replay`). */
type Mode = 'replay' | 'live' | 'day';
type RunMode = Exclude<Mode, 'day'>;

interface Settings {
  mode: Mode;
  /**
   * The past period as the time picker gives it: relative (`now-24h`, `now/d`)
   * or an absolute instant in epoch milliseconds. Older saves hold a UTC
   * `YYYY-MM-DDTHH:mm`.
   */
  from: string;
  to: string;
  step: number;
  rules: AlertRules;
}

/** What both sections read: which ClickHouse datasource and which of the organisation's providers. */
interface CommonSettings {
  datasourceUid?: string;
  providers: string;
  /** The zone every time on the page is shown and picked in ('utc', 'browser' or an IANA name). */
  timeZone?: TimeZone;
}

/** Settings of the "Tell the customer" section before the scope moved to COMMON_KEY. */
type LegacySettings = Partial<Settings & CommonSettings>;

/** One run's fixed inputs; a stopped replay keeps them, with its engine, to continue. */
interface RunState {
  engine: AlertEngine;
  datasource: DataSourceRef;
  pids: string[] | null;
  mode: RunMode;
  from: number;
  to: number;
  step: number;
}

function defaultSettings(): Settings {
  return {
    mode: 'live',
    from: 'now-24h',
    to: 'now',
    step: 3600,
    rules: DEFAULT_RULES,
  };
}

/** One end of the period in epoch seconds; NaN when it cannot be read. */
export function resolveTime(value: string, roundUp: boolean, timeZone: TimeZone, now = Date.now()): number {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    return fromUtcInput(value);
  }
  if (/^\d+$/.test(value)) {
    return Math.floor(Number(value) / 1000);
  }
  const parsed = value.includes('now') ? dateMath.toDateTime(value, { roundUp, timezone: timeZone, now }) : undefined;
  return parsed?.isValid() ? Math.floor(parsed.valueOf() / 1000) : NaN;
}

/** The picker's value for one end: relative stays as typed, absolute becomes epoch milliseconds. */
function rawEnd(raw: TimeRange['raw']['from'], resolved: TimeRange['from']): string {
  return typeof raw === 'string' && raw.includes('now') ? raw : String(resolved.valueOf());
}

function loadSettings(): Settings {
  const saved: LegacySettings = { ...store.getObject<LegacySettings>(SETTINGS_KEY, {}) };
  // The scope lives in COMMON_KEY now (migrated once by loadCommon).
  delete saved.datasourceUid;
  delete saved.providers;
  const base = defaultSettings();
  return { ...base, ...saved, rules: { ...DEFAULT_RULES, ...(saved.rules ?? {}) } };
}

function loadCommon(): CommonSettings {
  if (store.exists(COMMON_KEY)) {
    return { providers: '', ...store.getObject<Partial<CommonSettings>>(COMMON_KEY, {}) };
  }
  // First visit since the sections split: keep the scope the alerts page had.
  const legacy = store.getObject<LegacySettings>(SETTINGS_KEY, {});
  return { datasourceUid: legacy.datasourceUid, providers: legacy.providers ?? '' };
}

interface RuleField {
  key: keyof AlertRules;
  label: string;
  unit: string;
  /** What the rule changes, shown under the field. */
  description: string;
  /** Shown as percent, stored as a 0..1 share. */
  percent?: boolean;
}

function ruleFields(): RuleField[] {
  return [
    {
      key: 'minUsers',
      label: t('ai-insider-alerts.rule-min-users', 'Min active viewers'),
      description: t(
        'ai-insider-alerts.rule-min-users-desc',
        'A channel-minute is judged only with this many viewers; thinner minutes are neither failing nor clean.'
      ),
      unit: '',
    },
    {
      key: 'minErrUsers',
      label: t('ai-insider-alerts.rule-min-err-users', 'Min viewers with errors'),
      description: t(
        'ai-insider-alerts.rule-min-err-users-desc',
        'Viewers with a playback error needed in that minute.'
      ),
      unit: '',
    },
    {
      key: 'minErrShare',
      label: t('ai-insider-alerts.rule-min-share', 'Min share with errors'),
      description: t(
        'ai-insider-alerts.rule-min-share-desc',
        "…and they must be at least this share of the minute's viewers. Higher = fewer, surer incidents."
      ),
      unit: '%',
      percent: true,
    },
    {
      key: 'confirmMinutes',
      label: t('ai-insider-alerts.rule-confirm', 'Failing minutes to confirm'),
      description: t(
        'ai-insider-alerts.rule-confirm-desc',
        'Failing minutes before an incident is confirmed (detection). Higher = later but fewer false alarms.'
      ),
      unit: 'min',
    },
    {
      key: 'recoveryMinutes',
      label: t('ai-insider-alerts.rule-recovery', 'Clean minutes to call it back'),
      description: t(
        'ai-insider-alerts.rule-recovery-desc',
        'Minutes watched almost without errors before the channel is called back and "back" is sent.'
      ),
      unit: 'min',
    },
    {
      key: 'recoveryMinUsers',
      label: t('ai-insider-alerts.rule-recovery-users', 'Clean minute needs at least'),
      description: t(
        'ai-insider-alerts.rule-recovery-users-desc',
        'A minute counts as clean only with this many viewers: an empty channel is not a recovered one.'
      ),
      unit: t('ai-insider-alerts.unit-viewers', 'viewers'),
    },
    {
      key: 'quietCloseMinutes',
      label: t('ai-insider-alerts.rule-quiet-close', 'No clean viewing: close silently after'),
      description: t(
        'ai-insider-alerts.rule-quiet-close-desc',
        'Nobody watches after the outage: the incident closes after this, without a "back" message.'
      ),
      unit: 'min',
    },
    {
      key: 'pushDelayMinutes',
      label: t('ai-insider-alerts.rule-push-delay', 'Push only if still failing after'),
      description: t(
        'ai-insider-alerts.rule-push-delay-desc',
        'A push goes out only if the channel still fails this long after detection; shorter blips get the in-player message.'
      ),
      unit: 'min',
    },
    {
      key: 'cooldownMinutes',
      label: t('ai-insider-alerts.rule-cooldown', 'Do not repeat to a viewer within'),
      description: t(
        'ai-insider-alerts.rule-cooldown-desc',
        'A viewer told about a channel is not told about it again within this time.'
      ),
      unit: 'min',
    },
    {
      key: 'flapCount',
      label: t('ai-insider-alerts.rule-flap-count', 'Unstable channel: failures'),
      description: t(
        'ai-insider-alerts.rule-flap-count-desc',
        'This many incidents of one channel within the window make it "unstable": one message for the whole series.'
      ),
      unit: '',
    },
    {
      key: 'flapWindowMinutes',
      label: t('ai-insider-alerts.rule-flap-window', 'Unstable channel: within'),
      description: t(
        'ai-insider-alerts.rule-flap-window-desc',
        'The window for counting failures, and how long the channel must hold before "stable again".'
      ),
      unit: 'min',
    },
    {
      key: 'providerMinErrUsers',
      label: t('ai-insider-alerts.rule-provider-min', 'Provider-wide: min viewers with errors per 15 min'),
      description: t(
        'ai-insider-alerts.rule-provider-min-desc',
        'Provider-wide surge: at least this many viewers with errors in 15 minutes (any channels).'
      ),
      unit: '',
    },
    {
      key: 'providerSurgeFactor',
      label: t('ai-insider-alerts.rule-provider-factor', 'Provider-wide: times the usual level'),
      description: t(
        'ai-insider-alerts.rule-provider-factor-desc',
        '…and this many times the usual level at the same time on previous days. Higher = only big outages.'
      ),
      unit: '×',
    },
    {
      key: 'providerConfirmBuckets',
      label: t('ai-insider-alerts.rule-provider-confirm', 'Provider-wide: 15-min periods to confirm'),
      description: t(
        'ai-insider-alerts.rule-provider-confirm-desc',
        'Surging 15-minute periods in a row before a provider-wide incident is confirmed.'
      ),
      unit: '',
    },
    {
      key: 'providerBaselineDays',
      label: t('ai-insider-alerts.rule-provider-days', 'Usual level from previous'),
      description: t(
        'ai-insider-alerts.rule-provider-days-desc',
        'Previous days the usual level is taken from (median), for the provider-wide and app-level rules. The first days of a run have no baseline.'
      ),
      unit: t('ai-insider-alerts.unit-days', 'days'),
    },
    {
      key: 'providerMinViewerErrors',
      label: t('ai-insider-alerts.rule-provider-viewer', 'Provider-wide push: viewer had at least'),
      description: t(
        'ai-insider-alerts.rule-provider-viewer-desc',
        'Who gets the "service problems" push: viewers with this many errors over 2+ minutes; others get the in-player message.'
      ),
      unit: t('ai-insider-alerts.unit-errors', 'errors'),
    },
    {
      key: 'serviceStormFactor',
      label: t('ai-insider-alerts.rule-service-storm', 'Service down: app starts, times the usual'),
      description: t(
        'ai-insider-alerts.rule-service-storm-desc',
        'Middleware or login outage: viewers keep reopening the app. App starts at least this many times the usual level for the time of day…'
      ),
      unit: '×',
    },
    {
      key: 'servicePlayShare',
      label: t('ai-insider-alerts.rule-service-plays', 'Service down: playback at most'),
      description: t(
        'ai-insider-alerts.rule-service-plays-desc',
        '…while playback starts fall to this share of usual. Often without a single player error.'
      ),
      unit: '%',
      percent: true,
    },
    {
      key: 'serviceConfirmBuckets',
      label: t('ai-insider-alerts.rule-service-confirm', 'Service down: 5-min periods to confirm'),
      description: t(
        'ai-insider-alerts.rule-service-confirm-desc',
        'Periods in a row before a service outage is confirmed. 3 = 15 minutes, about one false alarm in five days.'
      ),
      unit: '',
    },
    {
      key: 'outageMinProviders',
      label: t('ai-insider-alerts.rule-outage-providers', 'Outage across providers: at least'),
      description: t(
        'ai-insider-alerts.rule-outage-providers-desc',
        'A data centre or network down: this many providers abnormal at once (playback, errors or app starts), 10 minutes in a row.'
      ),
      unit: t('ai-insider-alerts.unit-providers', 'providers'),
    },
    {
      key: 'noDataMinProviders',
      label: t('ai-insider-alerts.rule-no-data', 'No data: providers silent at once'),
      description: t(
        'ai-insider-alerts.rule-no-data-desc',
        'The analytics intake is down: this many providers send no events where they usually do. Silence is then not "all well".'
      ),
      unit: t('ai-insider-alerts.unit-providers', 'providers'),
    },
    {
      key: 'apologyWatchMinutes',
      label: t('ai-insider-alerts.rule-apology', 'Apology if watched in the hour before'),
      description: t(
        'ai-insider-alerts.rule-apology-desc',
        'Viewers who watched the channel this long in the hour before the outage get an apology with "back".'
      ),
      unit: 'min',
    },
    {
      key: 'customerMinChannels',
      label: t('ai-insider-alerts.rule-customer-channels', 'Customer side: min healthy channels failing'),
      description: t(
        'ai-insider-alerts.rule-customer-channels-desc',
        '"Your connection" diagnosis: errors on this many channels that worked for everyone else…'
      ),
      unit: '',
    },
    {
      key: 'customerMinMinutes',
      label: t('ai-insider-alerts.rule-customer-minutes', 'Customer side: min minutes'),
      description: t(
        'ai-insider-alerts.rule-customer-minutes-desc',
        '…over at least this many minutes. Sent once a day, never during a provider-wide problem.'
      ),
      unit: 'min',
    },
  ];
}

export function AlertsPage() {
  const access = useAiInsiderAccessState();
  const styles = useStyles2(getStyles);
  const [query, updateQuery] = useQueryParams();
  const section: Section = query.section === 'keep' ? 'keep' : 'tell';
  const home = useSelector((state) => state.navIndex[HOME_NAV_ID]);
  // The side menu section and the open sub-item: highlights it in the menu and
  // gives the breadcrumb Home › AI Insider Alerts › <section>.
  const navModel = useMemo((): NavModel => {
    const main = { ...buildAlertsNav(), parentItem: home };
    const node = main.children?.find((item) => item.id === alertsSectionNavId(section)) ?? main;
    return { main, node: { ...node, parentItem: main } };
  }, [home, section]);

  return (
    <Page navModel={navModel} renderTitle={() => <h1>{navModel.main.text}</h1>}>
      <Page.Contents>
        {access.loading ? (
          <div className={styles.center}>
            <Spinner />
          </div>
        ) : access.allowed ? (
          <AlertsSections
            orgScope={parseProviderScope(access.providerIds)}
            section={section}
            onShow={(next) => updateQuery({ section: next === 'keep' ? 'keep' : null }, true)}
          />
        ) : (
          <Alert severity="info" title={t('ai-insider-alerts.no-access-title', 'AI Insider is not enabled for you')}>
            <Trans i18nKey="ai-insider-alerts.no-access-body">
              Alerts are available to members of the organisation&apos;s AI Insider team. Ask a server admin to add you.
            </Trans>
          </Alert>
        )}
      </Page.Contents>
    </Page>
  );
}

export default AlertsPage;

function RunningBadge({ className }: { className?: string }) {
  return <Badge className={className} text={t('ai-insider-alerts.section-running', 'running')} color="green" />;
}

/**
 * The two sections and the scope they share. Both stay mounted, the inactive
 * one hidden, so switching never stops a live run, a replay or a scan.
 */
function AlertsSections({
  orgScope,
  section,
  onShow: show,
}: {
  orgScope: ProviderScope;
  section: Section;
  onShow: (section: Section) => void;
}) {
  const styles = useStyles2(getStyles);
  const [common, setCommon] = useState<CommonSettings>(loadCommon);
  const timeZone = common.timeZone ?? 'utc';
  // Set before the sections render: every alerts time below is shown in it.
  setDisplayTimeZone(timeZone);
  const [tellRunning, setTellRunning] = useState(false);
  const [keepRunning, setKeepRunning] = useState(false);
  // While Retention is hidden it mounts only once opened by its URL, then stays
  // mounted like the visible sections.
  const [keepMounted, setKeepMounted] = useState(RETENTION_VISIBLE || section === 'keep');

  useEffect(() => {
    store.setObject(COMMON_KEY, common);
  }, [common]);

  useEffect(() => {
    if (section === 'keep') {
      setKeepMounted(true);
    }
  }, [section]);

  const clickhouse = useMemo(
    () =>
      getDataSourceSrv()
        .getList({ all: true })
        .filter((ds) => ds.type.includes('clickhouse')),
    []
  );
  const datasource: DataSourceRef | undefined = useMemo(() => {
    const ds = clickhouse.find((d) => d.uid === common.datasourceUid) ?? clickhouse[0];
    return ds ? { uid: ds.uid, type: ds.type } : undefined;
  }, [clickhouse, common.datasourceUid]);

  const scope = effectiveScope(orgScope, common.providers);
  const scopeEmpty = Array.isArray(scope) && scope.length === 0;
  // A run keeps the scope it started with; the bar is locked only for the section on screen,
  // and each section names the scope of its own run under its progress.
  const locked = section === 'tell' ? tellRunning : keepRunning;
  const scopeText =
    orgScope === null
      ? t('ai-insider-alerts.scope-all', 'Organisation scope: all providers')
      : orgScope.length
        ? t('ai-insider-alerts.scope-list', 'Organisation scope: {{pids}}', { pids: orgScope.join(', ') })
        : t('ai-insider-alerts.scope-none', 'Organisation scope: no providers assigned');

  return (
    <div className={styles.page}>
      {keepMounted && (
        <TabsBar>
          <Tab
            label={t('ai-insider-alerts.section-tell', 'Quality')}
            active={section === 'tell'}
            onChangeTab={() => show('tell')}
            suffix={tellRunning ? RunningBadge : undefined}
          />
          <Tab
            label={t('ai-insider-alerts.section-keep', 'Retention')}
            active={section === 'keep'}
            onChangeTab={() => show('keep')}
            suffix={keepRunning ? RunningBadge : undefined}
          />
        </TabsBar>
      )}

      <section className={styles.card}>
        <div className={styles.controls}>
          <Field label={t('ai-insider-alerts.datasource', 'ClickHouse datasource')} className={styles.field} noMargin>
            <DataSourcePicker
              current={datasource?.uid ?? null}
              filter={(ds: DataSourceInstanceSettings) => ds.type.includes('clickhouse')}
              onChange={(ds: DataSourceInstanceSettings) => setCommon((c) => ({ ...c, datasourceUid: ds.uid }))}
              noDefault
              disabled={locked}
            />
          </Field>
          <Field
            label={t('ai-insider-alerts.providers', 'Providers')}
            description={scopeText}
            className={styles.providersField}
            noMargin
          >
            <Input
              placeholder={t('ai-insider-alerts.providers-placeholder', 'Empty = all in scope, or ids: 111, 222')}
              value={common.providers}
              onChange={(e) => {
                const providers = e.currentTarget.value;
                setCommon((c) => ({ ...c, providers }));
              }}
              disabled={locked}
            />
          </Field>
        </div>
        {!datasource && (
          <Alert severity="warning" title={t('ai-insider-alerts.no-ds', 'No ClickHouse datasource')}>
            <Trans i18nKey="ai-insider-alerts.no-ds-body">Add a ClickHouse datasource to read the event stream.</Trans>
          </Alert>
        )}
        {scopeEmpty && (
          <div className={styles.error}>
            <Trans i18nKey="ai-insider-alerts.scope-empty">
              No providers to read: the organisation has none assigned, or the filter is outside its scope.
            </Trans>
          </div>
        )}
      </section>

      <div hidden={section !== 'tell'}>
        <AlertsDatasourceContext.Provider value={datasource}>
          <AskInsiderProvider datasource={datasource}>
            <AlertsWorkbench
              datasource={datasource}
              scope={scope}
              onRunningChange={setTellRunning}
              timeZone={timeZone}
              onTimeZone={(tz) => setCommon((c) => ({ ...c, timeZone: tz }))}
            />
          </AskInsiderProvider>
        </AlertsDatasourceContext.Provider>
      </div>
      {keepMounted && (
        <div hidden={section !== 'keep'}>
          <KeepWorkbench
            datasource={datasource}
            scope={scope}
            active={section === 'keep'}
            onRunningChange={setKeepRunning}
            onProvidersChange={locked ? undefined : (providers) => setCommon((c) => ({ ...c, providers }))}
          />
        </div>
      )}
    </div>
  );
}

function snapshotOf(engine: AlertEngine, from: number, to: number): AlertsSnapshot {
  return {
    summary: engine.getSummary(),
    incidents: engine.getIncidents(),
    decisions: engine.getDecisions(),
    customer: engine.getCustomerSide(),
    dead: engine.getDeadChannels(),
    channels: engine.getChannelReport(),
    providers: engine.getProviderIncidents(),
    activity: engine.getActivityIncidents(),
    providerAffected: (id) => engine.getProviderAffected(id),
    groups: engine.getGroups(),
    blips: engine.blipCount,
    classOf: (i) => engine.incidentClass(i),
    affected: (id) => engine.getAffectedUsers(id),
    from,
    to,
  };
}

function AlertsWorkbench({
  datasource,
  scope,
  onRunningChange,
  timeZone,
  onTimeZone,
}: {
  datasource?: DataSourceRef;
  scope: ProviderScope;
  onRunningChange: (running: boolean) => void;
  timeZone: TimeZone;
  onTimeZone: (timeZone: TimeZone) => void;
}) {
  const styles = useStyles2(getStyles);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [advanced, setAdvanced] = useState<boolean>(() => store.getBool(ADVANCED_KEY, false));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [warning, setWarning] = useState<string>();
  const [snapshot, setSnapshot] = useState<AlertsSnapshot>();
  /** The last-24-hours overview, kept on screen while one of its hours is open. */
  const [overview, setOverview] = useState<Overview>();
  const [dayLoading, setDayLoading] = useState(false);
  /** The hour of the overview opened as a past period. */
  const [dayHour, setDayHour] = useState<number>();
  const [progress, setProgress] = useState<{
    kind: 'replay' | 'live' | 'export';
    clock: number;
    from: number;
    to?: number;
    rows?: number;
  }>();
  const abortRef = useRef<AbortController>();
  const unmountedRef = useRef(false);
  /** A replay that stopped before its end, kept so it can be continued. */
  const [resumable, setResumable] = useState<RunState>();
  /** Live keeps running through a failed step; this says which minutes are being retried. */
  const [liveIssue, setLiveIssue] = useState<string>();
  /** Where this page stands in the shared Live of its room (leader, follower, or alone). */
  const [share, setShare] = useState<ShareStatus>();
  /**
   * Datasource and providers of the run or export in progress: fixed at its
   * start, whatever the shared scope bar shows meanwhile (the other section
   * may change it).
   */
  const [runScope, setRunScope] = useState<Pick<RunState, 'datasource' | 'pids'>>();
  /** Range, scope and rules of the run on screen, for "Export run". */
  const runMetaRef = useRef<ExportMeta>();

  useEffect(() => {
    store.setObject(SETTINGS_KEY, settings);
  }, [settings]);

  useEffect(() => {
    store.set(ADVANCED_KEY, advanced);
  }, [advanced]);

  useEffect(() => {
    onRunningChange(running);
  }, [running, onRunningChange]);

  // Stop polling / replaying when the page is left. Closing the tab counts too:
  // a leading page then hands the shared Live over at once.
  useEffect(() => {
    const leave = () => abortRef.current?.abort();
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      unmountedRef.current = true;
      abortRef.current?.abort();
    };
  }, []);

  const update = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));
  const updateRule = (key: keyof AlertRules, value: number) =>
    setSettings((s) => ({ ...s, rules: { ...s.rules, [key]: value } }));

  const from = resolveTime(settings.from, false, timeZone);
  const to = resolveTime(settings.to, true, timeZone);
  const timeRange: TimeRange | undefined =
    Number.isFinite(from) && Number.isFinite(to)
      ? {
          from: dateTime(from * 1000),
          to: dateTime(to * 1000),
          raw: {
            from: settings.from.includes('now') ? settings.from : dateTime(from * 1000),
            to: settings.to.includes('now') ? settings.to : dateTime(to * 1000),
          },
        }
      : undefined;
  const rangeError =
    settings.mode !== 'replay'
      ? undefined
      : !Number.isFinite(from) || !Number.isFinite(to) || to <= from
        ? t('ai-insider-alerts.range-invalid', 'Set a valid range: "to" must be after "from".')
        : to - from > MAX_REPLAY_SEC
          ? t('ai-insider-alerts.range-too-long', 'Replay at most 7 days at a time.')
          : to > Date.now() / 1000
            ? t('ai-insider-alerts.range-future', 'The replay range cannot end in the future; use Live for now.')
            : undefined;
  const scopeEmpty = Array.isArray(scope) && scope.length === 0;
  const canRun = Boolean(datasource) && !rangeError && !scopeEmpty && !running;

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const start = () => {
    if (!datasource) {
      return;
    }
    if (settings.mode === 'day') {
      loadDay();
      return;
    }
    const windowFrom = settings.mode === 'replay' ? from : Math.floor(Date.now() / 1000) - 3600;
    runMetaRef.current = { from: windowFrom, to: windowFrom, pids: scope, rules: settings.rules, mode: settings.mode };
    reportInteraction('analytix_ai_alerts_run', { mode: settings.mode, hours: Math.round((to - from) / 3600) });
    execute({
      engine: new AlertEngine(settings.rules),
      datasource,
      pids: scope,
      mode: settings.mode,
      from: windowFrom,
      to,
      step: settings.step,
    });
  };

  /** Reads the last 24 hours per hour. */
  const loadDay = async () => {
    if (!datasource) {
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError(undefined);
    setRunning(true);
    setDayLoading(true);
    setSnapshot(undefined);
    setProgress(undefined);
    setDayHour(undefined);
    setRunScope({ datasource, pids: scope });
    reportInteraction('analytix_ai_alerts_day');
    try {
      const result = await loadOverview({
        datasource,
        pids: scope,
        now: Date.now() / 1000,
        signal: controller.signal,
        onPiece: setOverview,
      });
      setOverview(result);
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (abortRef.current === controller) {
        setRunning(false);
        setDayLoading(false);
      }
    }
  };

  /** Opens one hour of the overview as a past period, with the full detector. */
  const openHour = (hour: number) => {
    if (!datasource || running) {
      return;
    }
    const end = Math.min(hour + HOUR_SEC, Math.floor(Date.now() / 60000) * 60);
    reportInteraction('analytix_ai_alerts_day_hour');
    setDayHour(hour);
    update({ mode: 'replay', from: String(hour * 1000), to: String(end * 1000) });
    runMetaRef.current = { from: hour, to: hour, pids: scope, rules: settings.rules, mode: 'replay' };
    execute({
      engine: new AlertEngine(settings.rules),
      datasource,
      pids: scope,
      mode: 'replay',
      from: hour,
      to: end,
      step: 900,
    });
  };

  /** Continues a replay that a failure or "Stop" cut short, with everything it found so far. */
  const resume = () => {
    if (resumable) {
      reportInteraction('analytix_ai_alerts_resume');
      execute(resumable);
    }
  };

  const execute = async (run: RunState) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { engine } = run;
    const windowFrom = run.from;
    setResumable(undefined);
    setError(undefined);
    setWarning(undefined);
    setLiveIssue(undefined);
    setShare(undefined);
    setRunning(true);
    setRunScope({ datasource: run.datasource, pids: run.pids });
    setSnapshot(snapshotOf(engine, windowFrom, engine.processedTo ?? windowFrom));
    setProgress({
      kind: run.mode,
      clock: engine.processedTo ?? windowFrom,
      from: windowFrom,
      to: run.mode === 'replay' ? run.to : undefined,
    });

    const common = {
      datasource: run.datasource,
      pids: run.pids,
      engine,
      signal: controller.signal,
      onChunk: (clock: number) => {
        setLiveIssue(undefined);
        setProgress((p) => (p ? { ...p, clock } : p));
        setSnapshot(snapshotOf(engine, windowFrom, clock));
      },
      onWarning: (message: string) =>
        setWarning(
          t('ai-insider-alerts.names-warning', 'Provider names unavailable, showing ids ({{message}})', { message })
        ),
    };
    try {
      if (run.mode === 'replay') {
        await runReplay({ ...common, from: run.from, to: run.to, step: run.step });
      } else {
        const onLiveError = (message: string, at: number) =>
          setLiveIssue(
            t(
              'ai-insider-alerts.live-retrying',
              'The step after {{at}} {{tz}} failed ({{error}}). Live keeps running and tries the same minutes again every minute.',
              {
                tz: zoneLabel(),
                at: formatAt(at),
                error: message,
              }
            )
          );
        // One detector per room: this page runs it only while it leads, each
        // term on a fresh engine from the last hour, like a fresh Live.
        const runOwn = (signal: AbortSignal, publish: (snapshot: AlertsSnapshot) => void) => {
          const own = new AlertEngine(engine.rules);
          const from = Math.floor(Date.now() / 1000) - 3600;
          return runLive({
            ...common,
            engine: own,
            signal,
            pollMs: LIVE_POLL_MS,
            onLiveError,
            onChunk: (clock: number) => {
              const snap = snapshotOf(own, from, clock);
              setLiveIssue(undefined);
              setProgress((p) => (p ? { ...p, clock } : p));
              setSnapshot(snap);
              publish(snap);
            },
          });
        };
        if (run.datasource.uid) {
          await runSharedLive({
            room: liveRoom(run.datasource.uid, run.pids, engine.rules),
            clientId: liveClientId(),
            signal: controller.signal,
            runOwn,
            onSnapshot: (snap) => {
              setSnapshot(snap);
              setProgress((p) => (p ? { ...p, clock: snap.to } : p));
            },
            onStatus: setShare,
          });
        } else {
          await runOwn(controller.signal, () => undefined);
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        const at = engine.processedTo ?? windowFrom;
        setSnapshot(snapshotOf(engine, windowFrom, at));
        setError(
          t(
            'ai-insider-alerts.replay-stopped',
            'Replay stopped at {{at}} {{tz}}: {{error}}. "Continue replay" picks it up from there with everything found so far.',
            {
              tz: zoneLabel(),
              at: formatAt(at),
              error: e instanceof Error ? e.message : String(e),
            }
          )
        );
      }
    } finally {
      if (abortRef.current === controller) {
        setRunning(false);
        // A replay cut short by a failure or by "Stop" can be continued.
        if (run.mode === 'replay' && (engine.processedTo ?? run.from) < run.to && !unmountedRef.current) {
          setResumable(run);
        }
      }
    }
  };

  const exportDataset = async () => {
    if (!datasource) {
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError(undefined);
    setRunning(true);
    setRunScope({ datasource, pids: scope });
    setProgress({ kind: 'export', clock: from, from, to, rows: 0 });
    reportInteraction('analytix_ai_alerts_export_dataset', { hours: Math.round((to - from) / 3600) });
    try {
      const result = await runDatasetExport({
        datasource,
        pids: scope,
        from,
        to,
        rules: settings.rules,
        signal: controller.signal,
        onChunk: (clock, rows) => setProgress((p) => (p ? { ...p, clock, rows } : p)),
      });
      const ext = result.gzipped ? 'ndjson.gz' : 'ndjson';
      if (result.upTo > from) {
        downloadBlob(result.blob, exportFileName('dataset', from, result.upTo, ext));
      }
      if (!result.complete) {
        // Continue from where it stopped on the next click.
        update({ from: String(result.upTo * 1000) });
        setError(
          t(
            'ai-insider-alerts.export-partial',
            'Export stopped at {{at}} {{tz}} after repeated failures ({{error}}). Every hour before that is saved; "From" is set to {{at}} so the next export continues from there.',
            {
              tz: zoneLabel(),
              at: formatAt(result.upTo),
              error: result.error ?? '',
            }
          )
        );
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (abortRef.current === controller) {
        setRunning(false);
      }
    }
  };

  const exportCurrentRun = () => {
    if (snapshot && runMetaRef.current) {
      reportInteraction('analytix_ai_alerts_export_run');
      exportRun(snapshot, { ...runMetaRef.current, to: snapshot.to }).catch((e) =>
        setError(e instanceof Error ? e.message : String(e))
      );
    }
  };

  const dayOption = {
    label: t('ai-insider-alerts.mode-day', 'Last 24 hours'),
    value: 'day' as const,
    description: t('ai-insider-alerts.mode-day-tip', 'Errors per hour over the last day; click an hour to open it'),
  };
  const modeOptions = advanced
    ? [
        { label: t('ai-insider-alerts.mode-replay', 'Replay'), value: 'replay' as const },
        { label: t('ai-insider-alerts.mode-live', 'Live'), value: 'live' as const },
        dayOption,
      ]
    : [
        { label: t('ai-insider-alerts.mode-live', 'Live'), value: 'live' as const },
        dayOption,
        { label: t('ai-insider-alerts.mode-past', 'Past period'), value: 'replay' as const },
      ];
  const runLabel =
    settings.mode === 'day'
      ? t('ai-insider-alerts.show-day', 'Show last 24 hours')
      : settings.mode === 'replay'
        ? advanced
          ? t('ai-insider-alerts.run-replay', 'Run replay')
          : t('ai-insider-alerts.show-period', 'Show period')
        : advanced
          ? t('ai-insider-alerts.start-live', 'Start live')
          : t('ai-insider-alerts.start-monitoring', 'Start monitoring');
  const customRules = Object.entries(DEFAULT_RULES).some(([key, value]) => Reflect.get(settings.rules, key) !== value);
  const stepOptions = [
    { label: t('ai-insider-alerts.step-15m', '15 min'), value: 900 },
    { label: t('ai-insider-alerts.step-1h', '1 h'), value: 3600 },
  ];

  const pct =
    progress?.to !== undefined && progress.to > progress.from
      ? Math.min(100, Math.round(((progress.clock - progress.from) / (progress.to - progress.from)) * 100))
      : undefined;

  return (
    <div className={styles.page}>
      <div className={styles.introRow}>
        <p className={styles.intro}>
          {advanced ? (
            <Trans i18nKey="ai-insider-alerts.intro">
              Finds channels that go down on the operator side, decides who gets told and shows every message before it
              is sent. Replay past days to check detection.
            </Trans>
          ) : (
            <Trans i18nKey="ai-insider-alerts.intro-support">
              Shows what is broken right now on our side (channels, providers, the service), which viewers it hits and
              what they are told. Keep the page open: Live checks every minute.
            </Trans>
          )}
        </p>
        <InlineSwitch
          showLabel
          label={t('ai-insider-alerts.advanced', 'Advanced')}
          value={advanced}
          onChange={(e) => setAdvanced(e.currentTarget.checked)}
          title={t(
            'ai-insider-alerts.advanced-tip',
            'Every tab, the detection rules, exports and test pushes: for tuning and checking the rules'
          )}
        />
      </div>

      <section className={styles.card}>
        <div className={styles.controls}>
          <Field label={t('ai-insider-alerts.mode', 'Mode')} className={styles.field} noMargin>
            <RadioButtonGroup
              options={modeOptions}
              value={settings.mode}
              onChange={(mode) => {
                update({ mode });
                setDayHour(undefined);
              }}
              disabled={running}
            />
          </Field>
          {settings.mode === 'replay' && (
            <>
              <Field label={t('ai-insider-alerts.period', 'Period')} className={styles.rangeField} noMargin>
                <TimeRangeInput
                  value={timeRange ?? { from: dateTime(), to: dateTime(), raw: { from: 'now-24h', to: 'now' } }}
                  timeZone={timeZone}
                  onChange={(range) =>
                    update({ from: rawEnd(range.raw.from, range.from), to: rawEnd(range.raw.to, range.to) })
                  }
                  onChangeTimeZone={onTimeZone}
                  disabled={running}
                  showIcon
                />
              </Field>
              {advanced && (
                <Field
                  label={t('ai-insider-alerts.step', 'Step')}
                  description={t('ai-insider-alerts.step-description', 'how far the clock moves per query round')}
                  className={styles.field}
                  noMargin
                >
                  <RadioButtonGroup
                    options={stepOptions}
                    value={settings.step}
                    onChange={(step) => update({ step })}
                    disabled={running}
                  />
                </Field>
              )}
            </>
          )}
          <Field label={t('ai-insider-alerts.time-zone', 'Time zone')} className={styles.zoneField} noMargin>
            <TimeZonePicker
              value={timeZone}
              onChange={(tz) => onTimeZone(tz ?? 'utc')}
              includeInternal={[InternalTimeZones.utc, InternalTimeZones.localBrowserTime]}
              width={30}
            />
          </Field>
          <div className={styles.actions}>
            {running ? (
              <Button variant="destructive" icon="square-shape" onClick={stop}>
                <Trans i18nKey="ai-insider-alerts.stop">Stop</Trans>
              </Button>
            ) : (
              <Button
                icon={settings.mode === 'replay' ? 'history' : settings.mode === 'day' ? 'chart-line' : 'play'}
                onClick={start}
                disabled={!canRun}
              >
                {runLabel}
              </Button>
            )}
            {!running && settings.mode === 'replay' && resumable && (
              <Button
                variant="secondary"
                icon="arrow-right"
                onClick={resume}
                tooltip={t(
                  'ai-insider-alerts.continue-replay-tip',
                  'Continues the stopped replay on {{datasource}} from {{at}} {{tz}} to {{to}} {{tz}} with its original providers ({{pids}}) and rules',
                  {
                    tz: zoneLabel(),
                    datasource: datasourceName(resumable.datasource),
                    pids: scopePids(resumable.pids),
                    at: formatAt(resumable.engine.processedTo ?? resumable.from),
                    to: formatAt(resumable.to),
                    interpolation: { escapeValue: false },
                  }
                )}
              >
                <Trans i18nKey="ai-insider-alerts.continue-replay">Continue replay</Trans>
              </Button>
            )}
            {!running && advanced && settings.mode === 'replay' && (
              <Button
                variant="secondary"
                icon="download-alt"
                onClick={exportDataset}
                disabled={!canRun}
                tooltip={t(
                  'ai-insider-alerts.export-dataset-tip',
                  'Raw material for tuning the rules: every minute of channels with errors and every viewer-minute with an error (platform, network, ISP, city), hour by hour over the range'
                )}
              >
                <Trans i18nKey="ai-insider-alerts.export-dataset">Export dataset</Trans>
              </Button>
            )}
          </div>
        </div>

        {advanced && (
          <Collapse
            label={t('ai-insider-alerts.rules', 'Detection and messaging rules')}
            isOpen={rulesOpen}
            onToggle={() => setRulesOpen((o) => !o)}
            collapsible
          >
            <div className={styles.rules}>
              {ruleFields().map((f) => (
                <Field key={f.key} label={f.label} description={f.description} className={styles.field} noMargin>
                  <Input
                    type="number"
                    min={0}
                    step={f.key === 'providerSurgeFactor' ? 0.1 : 1}
                    suffix={f.unit || undefined}
                    value={f.percent ? Math.round(settings.rules[f.key] * 100) : settings.rules[f.key]}
                    onChange={(e) => {
                      const n = Number(e.currentTarget.value);
                      if (Number.isFinite(n) && n >= 0) {
                        updateRule(f.key, f.percent ? Math.min(100, n) / 100 : n);
                      }
                    }}
                    disabled={running}
                  />
                </Field>
              ))}
              <div className={styles.actions}>
                <Button
                  variant="secondary"
                  fill="text"
                  onClick={() => update({ rules: DEFAULT_RULES })}
                  disabled={running}
                >
                  <Trans i18nKey="ai-insider-alerts.rules-reset">Reset to defaults</Trans>
                </Button>
              </div>
            </div>
          </Collapse>
        )}

        {(running || progress) && (
          <div className={styles.status}>
            {running && <Spinner inline />}
            <span>
              {progress?.kind === 'export'
                ? t('ai-insider-alerts.progress-export', 'Exporting dataset up to {{clock}} {{tz}} · {{rows}} rows', {
                    tz: zoneLabel(),
                    clock: formatAt(progress.clock),
                    rows: formatCount(progress.rows ?? 0),
                  })
                : progress?.kind === 'replay'
                  ? t('ai-insider-alerts.progress-replay', 'Replayed up to {{clock}} {{tz}}', {
                      tz: zoneLabel(),
                      clock: formatAt(progress?.clock),
                    })
                  : share?.mode === 'follower'
                    ? t(
                        'ai-insider-alerts.progress-live-follower',
                        'Live, shared: the detector runs on another open page; showing its results up to {{clock}} {{tz}}',
                        {
                          tz: zoneLabel(),
                          clock: formatAt(progress?.clock),
                        }
                      )
                    : t(
                        'ai-insider-alerts.progress-live',
                        'Live: processed up to {{clock}} {{tz}}, checking every minute',
                        {
                          tz: zoneLabel(),
                          clock: formatAt(progress?.clock),
                        }
                      )}
              {pct !== undefined ? ` · ${pct}%` : ''}
            </span>
            {pct !== undefined && (
              <div className={styles.bar}>
                <div className={styles.barFill} style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>
        )}
        {running && runScope && <div className={styles.scope}>{runScopeText(runScope.datasource, runScope.pids)}</div>}
        {!advanced && customRules && (
          <div className={styles.warning}>
            <Trans i18nKey="ai-insider-alerts.custom-rules">
              Detection rules differ from the defaults (changed in Advanced): results may not match what others see.
            </Trans>
          </div>
        )}
        {rangeError && <div className={styles.error}>{rangeError}</div>}
        {error && (
          <Alert severity="error" title={t('ai-insider-alerts.error-title', 'Query failed')}>
            {error}
          </Alert>
        )}
        {running && share && share.mode !== 'local' && (
          <div className={styles.scope}>
            {share.mode === 'leader'
              ? t(
                  'ai-insider-alerts.share-leader',
                  'This page runs Live for everyone watching the same providers and rules ({{count}} pages now): the others show its results without querying ClickHouse. Keep it open; if it closes, another page takes over.',
                  { count: share.watchers }
                )
              : t(
                  'ai-insider-alerts.share-follower',
                  '{{count}} pages watch this Live; one of them queries ClickHouse for all. If it closes, this page takes over within a few minutes.',
                  { count: share.watchers }
                )}
          </div>
        )}
        {running && share?.issue && (
          <div className={styles.warning}>
            {t(
              'ai-insider-alerts.share-issue',
              'Shared Live: the AI Insider service did not answer ({{error}}). Trying again.',
              { error: share.issue, interpolation: { escapeValue: false } }
            )}
          </div>
        )}
        {liveIssue && running && <div className={styles.warning}>{liveIssue}</div>}
        {warning && <div className={styles.warning}>{warning}</div>}
      </section>

      {overview && (settings.mode === 'day' || (settings.mode === 'replay' && dayHour !== undefined)) && (
        <DayOverview overview={overview} loading={dayLoading} onHour={openHour} disabled={running} selected={dayHour} />
      )}

      {snapshot &&
        (advanced ? (
          <AlertsResults
            snapshot={snapshot}
            actions={
              <Button size="sm" variant="secondary" icon="download-alt" onClick={exportCurrentRun}>
                <Trans i18nKey="ai-insider-alerts.export-run">Export run</Trans>
              </Button>
            }
          />
        ) : (
          <SupportResults snapshot={snapshot} />
        ))}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  center: css({
    display: 'flex',
    justifyContent: 'center',
    padding: theme.spacing(8),
  }),
  page: css({
    display: 'grid',
    gap: theme.spacing(2),
    minWidth: 0,
  }),
  introRow: css({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing(1, 2),
  }),
  intro: css({
    color: analytix.textMuted,
    margin: 0,
    flex: '1 1 400px',
  }),
  card: css({
    background: analytix.surfaceRaised,
    border: `1px solid ${analytix.border}`,
    borderRadius: analytix.radiusPanel,
    padding: theme.spacing(2),
    display: 'grid',
    gap: theme.spacing(1.5),
  }),
  controls: css({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: theme.spacing(1.5, 2),
  }),
  field: css({
    minWidth: 180,
  }),
  rangeField: css({
    minWidth: 280,
  }),
  zoneField: css({
    minWidth: 200,
  }),
  providersField: css({
    // Wide enough for the whole placeholder: the hint says what to type.
    minWidth: 300,
  }),
  actions: css({
    display: 'flex',
    alignItems: 'flex-end',
    gap: theme.spacing(1),
  }),
  rules: css({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: theme.spacing(1.5, 2),
    alignItems: 'end',
  }),
  status: css({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.spacing(1),
    color: analytix.textMuted,
  }),
  bar: css({
    flex: '1 1 200px',
    height: 4,
    background: analytix.control,
    borderRadius: theme.shape.radius.default,
    overflow: 'hidden',
  }),
  barFill: css({
    height: '100%',
    background: analytix.green,
  }),
  error: css({
    color: theme.colors.error.text,
  }),
  warning: css({
    color: theme.colors.warning.text,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  scope: css({
    color: analytix.textMuted,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
});
