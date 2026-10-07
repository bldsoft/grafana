// Analytix: AI Insider Alerts — "tell the customer" up to (not including) the
// send step. Detects operator-side channel outages in the Analytix event
// stream, decides per viewer who would be told what and when (or deliberately
// not told), and replays past days as if they were live so the rules can be
// checked against real incidents before any message is ever sent.

import { css } from '@emotion/css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DataSourceInstanceSettings, DataSourceRef, GrafanaTheme2, NavModelItem, store } from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import { DataSourcePicker, getDataSourceSrv, reportInteraction } from '@grafana/runtime';
import { Alert, Button, Collapse, Field, Input, RadioButtonGroup, Spinner, useStyles2 } from '@grafana/ui';
import { Page } from 'app/core/components/Page/Page';
import { useAiInsiderAccessState } from 'app/features/dashboard-scene/ai-panel/useAiInsiderAccess';
import { analytix } from 'app/features/home/analytixTokens';

import { AlertsResults, AlertsSnapshot } from './AlertsResults';
import { AlertEngine } from './engine';
import { ExportMeta, downloadBlob, exportFileName, exportRun, runDatasetExport } from './export';
import { formatCount, formatUtc, fromUtcInput, toUtcInput } from './format';
import { runLive, runReplay } from './runner';
import { ProviderScope, effectiveScope, parseProviderScope } from './scope';
import { AlertRules, DEFAULT_RULES } from './types';

const SETTINGS_KEY = 'analytix.aiAlerts.settings.v1';
const MAX_REPLAY_SEC = 7 * 86400;
const LIVE_POLL_MS = 60000;

type Mode = 'replay' | 'live';

interface Settings {
  datasourceUid?: string;
  mode: Mode;
  from: string;
  to: string;
  step: number;
  providers: string;
  rules: AlertRules;
}

/** One run's fixed inputs; a stopped replay keeps them, with its engine, to continue. */
interface RunState {
  engine: AlertEngine;
  datasource: DataSourceRef;
  pids: string[] | null;
  mode: Mode;
  from: number;
  to: number;
  step: number;
}

function defaultSettings(): Settings {
  const today = Math.floor(Date.now() / 86400000) * 86400;
  return {
    mode: 'replay',
    from: toUtcInput(today - 86400),
    to: toUtcInput(today),
    step: 3600,
    providers: '',
    rules: DEFAULT_RULES,
  };
}

function loadSettings(): Settings {
  const saved = store.getObject<Partial<Settings>>(SETTINGS_KEY, {});
  const base = defaultSettings();
  return { ...base, ...saved, rules: { ...DEFAULT_RULES, ...(saved.rules ?? {}) } };
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
  const pageNav: NavModelItem = {
    id: 'ai-insider-alerts',
    text: t('ai-insider-alerts.page-title', 'AI Insider Alerts'),
    icon: 'bell',
  };

  return (
    <Page navId="home" pageNav={pageNav}>
      <Page.Contents>
        {access.loading ? (
          <div className={styles.center}>
            <Spinner />
          </div>
        ) : access.allowed ? (
          <AlertsWorkbench orgScope={parseProviderScope(access.providerIds)} />
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

function AlertsWorkbench({ orgScope }: { orgScope: ProviderScope }) {
  const styles = useStyles2(getStyles);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [warning, setWarning] = useState<string>();
  const [snapshot, setSnapshot] = useState<AlertsSnapshot>();
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
  /** Range, scope and rules of the run on screen, for "Export run". */
  const runMetaRef = useRef<ExportMeta>();

  const clickhouse = useMemo(
    () =>
      getDataSourceSrv()
        .getList({ all: true })
        .filter((ds) => ds.type.includes('clickhouse')),
    []
  );
  const datasource: DataSourceRef | undefined = useMemo(() => {
    const ds = clickhouse.find((d) => d.uid === settings.datasourceUid) ?? clickhouse[0];
    return ds ? { uid: ds.uid, type: ds.type } : undefined;
  }, [clickhouse, settings.datasourceUid]);

  useEffect(() => {
    store.setObject(SETTINGS_KEY, settings);
  }, [settings]);

  // Stop polling / replaying when the page is left.
  useEffect(
    () => () => {
      unmountedRef.current = true;
      abortRef.current?.abort();
    },
    []
  );

  const update = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));
  const updateRule = (key: keyof AlertRules, value: number) =>
    setSettings((s) => ({ ...s, rules: { ...s.rules, [key]: value } }));

  const scope = effectiveScope(orgScope, settings.providers);
  const from = fromUtcInput(settings.from);
  const to = fromUtcInput(settings.to);
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
    setRunning(true);
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
        await runLive({
          ...common,
          pollMs: LIVE_POLL_MS,
          onLiveError: (message, at) =>
            setLiveIssue(
              t(
                'ai-insider-alerts.live-retrying',
                'The step after {{at}} UTC failed ({{error}}). Live keeps running and tries the same minutes again every minute.',
                { at: formatUtc(at), error: message }
              )
            ),
        });
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        const at = engine.processedTo ?? windowFrom;
        setSnapshot(snapshotOf(engine, windowFrom, at));
        setError(
          t(
            'ai-insider-alerts.replay-stopped',
            'Replay stopped at {{at}} UTC: {{error}}. "Continue replay" picks it up from there with everything found so far.',
            { at: formatUtc(at), error: e instanceof Error ? e.message : String(e) }
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
        update({ from: toUtcInput(result.upTo) });
        setError(
          t(
            'ai-insider-alerts.export-partial',
            'Export stopped at {{at}} UTC after repeated failures ({{error}}). Every hour before that is saved; "From" is set to {{at}} so the next export continues from there.',
            { at: formatUtc(result.upTo), error: result.error ?? '' }
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

  const modeOptions = [
    { label: t('ai-insider-alerts.mode-replay', 'Replay'), value: 'replay' as const },
    { label: t('ai-insider-alerts.mode-live', 'Live'), value: 'live' as const },
  ];
  const stepOptions = [
    { label: t('ai-insider-alerts.step-15m', '15 min'), value: 900 },
    { label: t('ai-insider-alerts.step-1h', '1 h'), value: 3600 },
  ];
  const scopeText =
    orgScope === null
      ? t('ai-insider-alerts.scope-all', 'Organisation scope: all providers')
      : orgScope.length
        ? t('ai-insider-alerts.scope-list', 'Organisation scope: {{pids}}', { pids: orgScope.join(', ') })
        : t('ai-insider-alerts.scope-none', 'Organisation scope: no providers assigned');

  const pct =
    progress?.to !== undefined && progress.to > progress.from
      ? Math.min(100, Math.round(((progress.clock - progress.from) / (progress.to - progress.from)) * 100))
      : undefined;

  return (
    <div className={styles.page}>
      <p className={styles.intro}>
        <Trans i18nKey="ai-insider-alerts.intro">
          Finds channels that go down on the operator side, decides which viewers would be told — and which would not,
          because they were already told or the problem is on their side — and shows every message before anything is
          sent. Replay past days to see whether an incident would have been caught.
        </Trans>
      </p>

      <section className={styles.card}>
        <div className={styles.controls}>
          <Field label={t('ai-insider-alerts.datasource', 'ClickHouse datasource')} className={styles.field} noMargin>
            <DataSourcePicker
              current={datasource?.uid ?? null}
              filter={(ds: DataSourceInstanceSettings) => ds.type.includes('clickhouse')}
              onChange={(ds: DataSourceInstanceSettings) => update({ datasourceUid: ds.uid })}
              noDefault
              disabled={running}
            />
          </Field>
          <Field label={t('ai-insider-alerts.mode', 'Mode')} className={styles.field} noMargin>
            <RadioButtonGroup
              options={modeOptions}
              value={settings.mode}
              onChange={(mode) => update({ mode })}
              disabled={running}
            />
          </Field>
          {settings.mode === 'replay' && (
            <>
              <Field label={t('ai-insider-alerts.from', 'From (UTC)')} className={styles.field} noMargin>
                <Input
                  type="datetime-local"
                  value={settings.from}
                  onChange={(e) => update({ from: e.currentTarget.value })}
                  disabled={running}
                />
              </Field>
              <Field label={t('ai-insider-alerts.to', 'To (UTC)')} className={styles.field} noMargin>
                <Input
                  type="datetime-local"
                  value={settings.to}
                  onChange={(e) => update({ to: e.currentTarget.value })}
                  disabled={running}
                />
              </Field>
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
            </>
          )}
          <Field
            label={t('ai-insider-alerts.providers', 'Providers')}
            description={scopeText}
            className={styles.field}
            noMargin
          >
            <Input
              placeholder={t('ai-insider-alerts.providers-placeholder', 'Empty = all in scope, or ids: 111, 222')}
              value={settings.providers}
              onChange={(e) => update({ providers: e.currentTarget.value })}
              disabled={running}
            />
          </Field>
          <div className={styles.actions}>
            {running ? (
              <Button variant="destructive" icon="square-shape" onClick={stop}>
                <Trans i18nKey="ai-insider-alerts.stop">Stop</Trans>
              </Button>
            ) : (
              <Button icon={settings.mode === 'replay' ? 'history' : 'play'} onClick={start} disabled={!canRun}>
                {settings.mode === 'replay'
                  ? t('ai-insider-alerts.run-replay', 'Run replay')
                  : t('ai-insider-alerts.start-live', 'Start live')}
              </Button>
            )}
            {!running && settings.mode === 'replay' && resumable && (
              <Button
                variant="secondary"
                icon="arrow-right"
                onClick={resume}
                tooltip={t(
                  'ai-insider-alerts.continue-replay-tip',
                  'Continues the stopped replay from {{at}} UTC to {{to}} UTC with its original providers and rules',
                  {
                    at: formatUtc(resumable.engine.processedTo ?? resumable.from),
                    to: formatUtc(resumable.to),
                  }
                )}
              >
                <Trans i18nKey="ai-insider-alerts.continue-replay">Continue replay</Trans>
              </Button>
            )}
            {!running && settings.mode === 'replay' && (
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

        {(running || progress) && (
          <div className={styles.status}>
            {running && <Spinner inline />}
            <span>
              {progress?.kind === 'export'
                ? t('ai-insider-alerts.progress-export', 'Exporting dataset up to {{clock}} UTC · {{rows}} rows', {
                    clock: formatUtc(progress.clock),
                    rows: formatCount(progress.rows ?? 0),
                  })
                : progress?.kind === 'replay'
                  ? t('ai-insider-alerts.progress-replay', 'Replayed up to {{clock}} UTC', {
                      clock: formatUtc(progress?.clock),
                    })
                  : t('ai-insider-alerts.progress-live', 'Live: processed up to {{clock}} UTC, checking every minute', {
                      clock: formatUtc(progress?.clock),
                    })}
              {pct !== undefined ? ` · ${pct}%` : ''}
            </span>
            {pct !== undefined && (
              <div className={styles.bar}>
                <div className={styles.barFill} style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>
        )}
        {!datasource && (
          <Alert severity="warning" title={t('ai-insider-alerts.no-ds', 'No ClickHouse datasource')}>
            <Trans i18nKey="ai-insider-alerts.no-ds-body">Add a ClickHouse datasource to read the event stream.</Trans>
          </Alert>
        )}
        {rangeError && <div className={styles.error}>{rangeError}</div>}
        {scopeEmpty && (
          <div className={styles.error}>
            <Trans i18nKey="ai-insider-alerts.scope-empty">
              No providers to read: the organisation has none assigned, or the filter is outside its scope.
            </Trans>
          </div>
        )}
        {error && (
          <Alert severity="error" title={t('ai-insider-alerts.error-title', 'Query failed')}>
            {error}
          </Alert>
        )}
        {liveIssue && running && <div className={styles.warning}>{liveIssue}</div>}
        {warning && <div className={styles.warning}>{warning}</div>}
      </section>

      {snapshot && (
        <AlertsResults
          snapshot={snapshot}
          actions={
            <Button size="sm" variant="secondary" icon="download-alt" onClick={exportCurrentRun}>
              <Trans i18nKey="ai-insider-alerts.export-run">Export run</Trans>
            </Button>
          }
        />
      )}
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
  intro: css({
    color: analytix.textMuted,
    maxWidth: '80ch',
    margin: 0,
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
});
