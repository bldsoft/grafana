// Analytix: AI Insider Alerts — "Keep the customer" section: the controls of
// the retention scan (as-of day, Scan or Backtest, GA4 evidence, delivery per
// provider, rules), the size estimate before a run, and the run itself. The
// engine keeps every day it has read, so the next run on the same datasource
// and providers reads only the days it does not hold yet, and a stopped or
// failed run continues from there.

import { css } from '@emotion/css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DataSourceRef, GrafanaTheme2, store } from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import { getDataSourceSrv, reportInteraction } from '@grafana/runtime';
import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Field,
  Input,
  RadioButtonGroup,
  Spinner,
  Switch,
  useStyles2,
} from '@grafana/ui';
import { DataDomain, fetchCapabilities } from 'app/features/dashboard-scene/ai-panel/assistantClient';
import { analytix } from 'app/features/home/analytixTokens';

import { formatCount } from '../format';
import { ProviderScope } from '../scope';

import { KeepResults } from './KeepResults';
import { KeepEngine, graceDays, parseDeliveryByPid, ruleDays } from './engine';
import { engineKey, estimateScan, lastCompleteDay, planScan, runKeepScan } from './runner';
import { RAW, isoDay, parseIsoDay } from './text';
import {
  DEFAULT_KEEP_RULES,
  KEEP_MAX_ACCOUNT_DAYS,
  KeepEngineApi,
  KeepEngineOptions,
  KeepProgress,
  KeepRules,
  KeepSettings,
  KeepSnapshot,
  PlanClass,
  ScanEstimate,
  ScanPlan,
} from './types';

const SETTINGS_KEY = 'analytix.aiAlerts.keep.v1';
const DAY = 86400;
/** Wait after the last change before the size estimate queries ClickHouse. */
const ESTIMATE_DEBOUNCE_MS = 800;
/** How often "the latest complete day" is recomputed while the page is open. */
const CLOCK_TICK_MS = 5 * 60 * 1000;

type Ga4State = 'loading' | 'unreachable' | DataDomain['status'];

/** One run's fixed inputs; a stopped or failed run keeps them, with its engine, to continue. */
interface KeepRun {
  engine: KeepEngineApi;
  datasource: DataSourceRef;
  pids: string[] | null;
  mode: KeepSettings['mode'];
  asOf: number;
  backtest?: { from: number; to: number };
  useBehavior: boolean;
  plan: ScanPlan;
  /** Identity of the plan and scope, to reuse an estimate made for exactly this run. */
  estimateKey: string;
  /** The size estimate let this run through (a continued run is not checked again). */
  sizeChecked: boolean;
}

interface EstimateState {
  key: string;
  loading: boolean;
  value: ScanEstimate | null;
}

function defaultSettings(): KeepSettings {
  return {
    asOf: '',
    mode: 'scan',
    backtestFrom: '',
    backtestTo: '',
    deliveryByPid: '',
    useBehavior: false,
    planClassOverrides: {},
    includeTitles: false,
    rules: DEFAULT_KEEP_RULES,
  };
}

function loadSettings(): KeepSettings {
  const saved = store.getObject<Partial<KeepSettings>>(SETTINGS_KEY, {});
  return {
    ...defaultSettings(),
    ...saved,
    planClassOverrides: { ...(saved.planClassOverrides ?? {}) },
    // New rules get their defaults over an older saved state.
    rules: { ...DEFAULT_KEEP_RULES, ...(saved.rules ?? {}) },
  };
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface RuleField {
  key: keyof KeepRules;
  label: string;
  unit: string;
  /** What the rule changes, shown under the field. */
  description: string;
  /** percent: shown ×100, stored as a 0..1 share; boolean: a checkbox; text: free text. */
  kind?: 'percent' | 'boolean' | 'text';
  step?: number;
  min?: number;
  /** Larger values are cut to this (day windows: every day is one more query). */
  max?: number;
  /** Whole numbers only (day counts): a fraction is rounded. */
  integer?: boolean;
}

/** "Running on ClickHouse · providers 111, 222": the scope a run captured at its start. */
export function runScopeText(datasource: DataSourceRef, pids: string[] | null): string {
  return t('ai-insider-alerts.run-scope', 'Running on {{datasource}} · providers {{pids}}', {
    datasource: datasourceName(datasource),
    pids: scopePids(pids),
    ...RAW,
  });
}

/** The datasource's name as the picker shows it; its uid when it is not known (any more). */
export function datasourceName(ref: DataSourceRef): string {
  try {
    return getDataSourceSrv().getInstanceSettings(ref)?.name ?? ref.uid ?? '';
  } catch {
    return ref.uid ?? '';
  }
}

/** Providers of a run: null = all of the organisation's. */
export function scopePids(pids: string[] | null): string {
  return pids === null ? t('ai-insider-alerts.run-scope-all', 'all in scope') : pids.join(', ');
}

function ruleFields(): RuleField[] {
  const days = t('ai-insider-alerts.keep.unit-days', 'days');
  return [
    {
      key: 'recentDays',
      label: t('ai-insider-alerts.keep.rule-recent', 'Recent window'),
      description: t(
        'ai-insider-alerts.keep.rule-recent-desc',
        'Days ending with the as-of day, compared with the baseline. Counts are summed over the window; distinct titles are averaged per active day (they do not add up across days).'
      ),
      unit: days,
      min: 1,
      max: 28,
      integer: true,
    },
    {
      key: 'baselineDays',
      label: t('ai-insider-alerts.keep.rule-baseline', 'Baseline window'),
      description: t(
        'ai-insider-alerts.keep.rule-baseline-desc',
        "Days right before the recent window: the customer's usual. Longer = steadier, but more days to read."
      ),
      unit: days,
      min: 1,
      max: 56,
      integer: true,
    },
    {
      key: 'renewalHistoryDays',
      label: t('ai-insider-alerts.keep.rule-history', 'Subscription history'),
      description: t(
        'ai-insider-alerts.keep.rule-history-desc',
        'Days read for renewals, ending with the as-of day. Days before both windows use a light query (activity and subscription only).'
      ),
      unit: days,
      min: 1,
      max: 90,
      integer: true,
    },
    {
      key: 'minBaselineActiveDays',
      label: t('ai-insider-alerts.keep.rule-min-active', 'Judged from active baseline days'),
      description: t(
        'ai-insider-alerts.keep.rule-min-active-desc',
        'Customers active on fewer baseline days are too new or too rare to judge.'
      ),
      unit: days,
      integer: true,
    },
    {
      key: 'includeFreePlans',
      label: t('ai-insider-alerts.keep.rule-free', 'Also judge free and trial plans'),
      description: t(
        'ai-insider-alerts.keep.rule-free-desc',
        'Off: customers whose baseline plan is free or a trial are left out (classes on the Quality tab).'
      ),
      unit: '',
      kind: 'boolean',
    },
    {
      key: 'quietDays',
      label: t('ai-insider-alerts.keep.rule-quiet', 'Quiet: no activity for'),
      description: t('ai-insider-alerts.keep.rule-quiet-desc', 'Not seen on any device for at least this long…'),
      unit: days,
      min: 1,
      integer: true,
    },
    {
      key: 'quietGapFactor',
      label: t('ai-insider-alerts.keep.rule-quiet-gap', 'Quiet: times the usual gap'),
      description: t(
        'ai-insider-alerts.keep.rule-quiet-gap-desc',
        '…and this many times the longest gap between active baseline days, so weekly viewers are not called quiet.'
      ),
      unit: '×',
      step: 0.1,
    },
    {
      key: 'fadeShare',
      label: t('ai-insider-alerts.keep.rule-fade', 'Fading: watch time at most'),
      description: t(
        'ai-insider-alerts.keep.rule-fade-desc',
        "Recent watch time per day as a share of the baseline, after the provider's median change (season, outages)."
      ),
      unit: '%',
      kind: 'percent',
    },
    {
      key: 'minBaselineWatchMin',
      label: t('ai-insider-alerts.keep.rule-fade-min', 'Fading: judged from'),
      description: t(
        'ai-insider-alerts.keep.rule-fade-min-desc',
        'Only customers who watched this much per baseline day; set-top box only customers are judged by active days.'
      ),
      unit: t('ai-insider-alerts.keep.unit-min-day', 'min/day'),
    },
    {
      key: 'stbShiftShare',
      label: t('ai-insider-alerts.keep.rule-stb', 'Fading: set-top box shift'),
      description: t(
        'ai-insider-alerts.keep.rule-stb-desc',
        'Set-top boxes report no watch time: when their share of plays grew by more than this, fading also needs fewer plays.'
      ),
      unit: '%',
      kind: 'percent',
    },
    {
      key: 'renewalWindowDays',
      label: t('ai-insider-alerts.keep.rule-expiring', 'Expiring: ends within'),
      description: t(
        'ai-insider-alerts.keep.rule-expiring-desc',
        'A known subscription end within this many days after the as-of day.'
      ),
      unit: days,
      integer: true,
    },
    {
      key: 'lapsedDays',
      label: t('ai-insider-alerts.keep.rule-lapsed', 'Lapsed: ended at most'),
      description: t(
        'ai-insider-alerts.keep.rule-lapsed-desc',
        'Days ago, while the customer still uses the app: a win-back. Ended and silent goes to Renewals instead.'
      ),
      unit: days,
      integer: true,
    },
    {
      key: 'lapsedGraceDays',
      label: t('ai-insider-alerts.keep.rule-grace', 'Lapsed: wait after the end'),
      description: t(
        'ai-insider-alerts.keep.rule-grace-desc',
        'Automatic payment retries; a playback refused for an inactive subscription skips the wait.'
      ),
      unit: days,
      integer: true,
    },
    {
      key: 'winBackStep2Days',
      label: t('ai-insider-alerts.keep.rule-step2', 'Win-back: step 2 after'),
      description: t(
        'ai-insider-alerts.keep.rule-step2-desc',
        'Step 1 is a payment link without a discount; this long after the end, step 2 offers a discount or bonus.'
      ),
      unit: days,
      integer: true,
    },
    {
      key: 'renewalLeadDays',
      label: t('ai-insider-alerts.keep.rule-lead', 'Renewal campaign: first step'),
      description: t(
        'ai-insider-alerts.keep.rule-lead-desc',
        'Days before the end; then a reminder 1 day before and a payment link 1 day after.'
      ),
      unit: days,
      integer: true,
    },
    {
      key: 'techErrShare',
      label: t('ai-insider-alerts.keep.rule-tech-share', 'Technical: failed playbacks'),
      description: t(
        'ai-insider-alerts.keep.rule-tech-share-desc',
        "Share of recent playbacks that failed, and at least twice the customer's own baseline share…"
      ),
      unit: '%',
      kind: 'percent',
    },
    {
      key: 'techMinErrors',
      label: t('ai-insider-alerts.keep.rule-tech-errors', 'Technical: at least'),
      description: t('ai-insider-alerts.keep.rule-tech-errors-desc', '…with at least this many failed playbacks…'),
      unit: t('ai-insider-alerts.keep.unit-failures', 'failures'),
    },
    {
      key: 'techMinDays',
      label: t('ai-insider-alerts.keep.rule-tech-days', 'Technical: on at least'),
      description: t(
        'ai-insider-alerts.keep.rule-tech-days-desc',
        '…on this many different days. Technical customers go to support; promotions to them are held back.'
      ),
      unit: days,
      integer: true,
    },
    {
      key: 'techBufferingPerHour',
      label: t('ai-insider-alerts.keep.rule-buffering', 'Technical: buffering stops per hour'),
      description: t(
        'ai-insider-alerts.keep.rule-buffering-desc',
        'Or this many buffering stops per watched hour (and twice the baseline), with at least an hour watched.'
      ),
      unit: '',
      step: 0.5,
    },
    {
      key: 'diversityDrop',
      label: t('ai-insider-alerts.keep.rule-diversity', 'Content: distinct titles at most'),
      description: t(
        'ai-insider-alerts.keep.rule-diversity-desc',
        'Distinct titles per active day fell to this share of the baseline (which had at least 2).'
      ),
      unit: '%',
      kind: 'percent',
    },
    {
      key: 'failedSearchMin',
      label: t('ai-insider-alerts.keep.rule-search', 'Content: searches opening nothing'),
      description: t(
        'ai-insider-alerts.keep.rule-search-desc',
        'Search sessions in the recent window that opened no result. The search text itself is never read.'
      ),
      unit: '',
    },
    {
      key: 'topTitleShare',
      label: t('ai-insider-alerts.keep.rule-top-title', 'Content: favourite title share'),
      description: t(
        'ai-insider-alerts.keep.rule-top-title-desc',
        'The baseline favourite took at least this share of the watch time and was not watched recently.'
      ),
      unit: '%',
      kind: 'percent',
    },
    {
      key: 'holdoutShare',
      label: t('ai-insider-alerts.keep.rule-holdout', 'Control group'),
      description: t(
        'ai-insider-alerts.keep.rule-holdout-desc',
        'Share of at-risk customers never contacted, to measure the effect. Smaller = a larger detectable effect only (MDE on the control tile).'
      ),
      unit: '%',
      kind: 'percent',
    },
    {
      key: 'holdoutSalt',
      label: t('ai-insider-alerts.keep.rule-salt', 'Control group salt'),
      description: t(
        'ai-insider-alerts.keep.rule-salt-desc',
        'The same salt keeps the same customers in control; change it to draw a new group (e.g. per quarter).'
      ),
      unit: '',
      kind: 'text',
    },
    {
      key: 'dailyCapacity',
      label: t('ai-insider-alerts.keep.rule-capacity', 'Daily capacity per action'),
      description: t(
        'ai-insider-alerts.keep.rule-capacity-desc',
        'Jobs per action and day the teams can handle; lower priority beyond it is deferred. 0 = no limit.'
      ),
      unit: t('ai-insider-alerts.keep.unit-jobs', 'jobs'),
    },
    {
      key: 'outcomeDays',
      label: t('ai-insider-alerts.keep.rule-outcome', 'Backtest: outcome within'),
      description: t(
        'ai-insider-alerts.keep.rule-outcome-desc',
        'Days after each as-of date in which renewal, return or recovery is looked for.'
      ),
      unit: days,
      min: 1,
      max: 60,
      integer: true,
    },
    {
      key: 'labelGraceDays',
      label: t('ai-insider-alerts.keep.rule-label-grace', 'Backtest: grace for late renewals'),
      description: t(
        'ai-insider-alerts.keep.rule-label-grace-desc',
        'Apps report a renewal when they are opened. Without a renewal or a lapse seen in time the outcome is "censored" and left out of lift and recall.'
      ),
      unit: days,
      min: 0,
      max: 14,
      integer: true,
    },
    {
      key: 'backtestStepDays',
      label: t('ai-insider-alerts.keep.rule-step', 'Backtest: step'),
      description: t('ai-insider-alerts.keep.rule-step-desc', 'Days between as-of dates.'),
      unit: days,
      min: 1,
      integer: true,
    },
    {
      key: 'recoveryShare',
      label: t('ai-insider-alerts.keep.rule-recovery', 'Backtest: recovered at'),
      description: t(
        'ai-insider-alerts.keep.rule-recovery-desc',
        'Watch time per day in the horizon at least this share of the baseline counts as recovered.'
      ),
      unit: '%',
      kind: 'percent',
    },
    {
      key: 'cooldownDays',
      label: t('ai-insider-alerts.keep.rule-cooldown', 'Backtest: no new job within'),
      description: t(
        'ai-insider-alerts.keep.rule-cooldown-desc',
        'One job per customer within this many days across as-of dates.'
      ),
      unit: days,
      integer: true,
    },
  ];
}

export interface KeepWorkbenchProps {
  datasource?: DataSourceRef;
  /** Providers to read: null = all of the organisation's, [] = none. */
  scope: ProviderScope;
  /** True while the section is on screen: only then does it query anything on its own. */
  active: boolean;
  onRunningChange?: (running: boolean) => void;
}

export function KeepWorkbench({ datasource, scope, active, onRunningChange }: KeepWorkbenchProps) {
  const styles = useStyles2(getStyles);
  const [settings, setSettings] = useState<KeepSettings>(loadSettings);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [progress, setProgress] = useState<KeepProgress>();
  /** The snapshot on screen and the rules it was made with. */
  const [result, setResult] = useState<{ snapshot: KeepSnapshot; rules: KeepRules }>();
  /** A run that stopped before its end, kept so it can be continued. */
  const [resumable, setResumable] = useState<KeepRun>();
  /**
   * Datasource and providers of the run in progress: fixed at its start,
   * whatever the shared scope bar shows meanwhile (another section may change it).
   */
  const [runScope, setRunScope] = useState<Pick<KeepRun, 'datasource' | 'pids'>>();
  const [estimate, setEstimate] = useState<EstimateState>();
  const [ga4, setGa4] = useState<Ga4State>('loading');
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const abortRef = useRef<AbortController>();
  const unmountedRef = useRef(false);
  const estimateRef = useRef<EstimateState>();
  estimateRef.current = estimate;
  /**
   * The engine holds the days read so far. It is kept while the datasource
   * and the providers stay the same (another scope reads other rows).
   */
  const engineRef = useRef<{ key: string; config: string; engine: KeepEngineApi }>();

  useEffect(() => {
    store.setObject(SETTINGS_KEY, settings);
  }, [settings]);

  useEffect(() => {
    onRunningChange?.(running);
  }, [running, onRunningChange]);

  // Stop the run when the page is left.
  useEffect(
    () => () => {
      unmountedRef.current = true;
      abortRef.current?.abort();
    },
    []
  );

  // "The latest complete day" moves on while the page stays open.
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // GA4 evidence needs the AI Insider service; ask once, when the section is first shown.
  const askedRef = useRef(false);
  useEffect(() => {
    if (!active || askedRef.current) {
      return;
    }
    askedRef.current = true;
    fetchCapabilities().then((domains) => {
      if (!unmountedRef.current) {
        setGa4(domains === null ? 'unreachable' : (domains.find((d) => d.id === 'behavior')?.status ?? 'off'));
      }
    });
  }, [active]);

  const update = (patch: Partial<KeepSettings>) => setSettings((s) => ({ ...s, ...patch }));
  const updateRule = (key: keyof KeepRules, value: KeepRules[keyof KeepRules]) =>
    setSettings((s) => ({ ...s, rules: { ...s.rules, [key]: value } }));
  const onPlanClassChange = useCallback((pid: string, plan: string, cls: PlanClass | undefined) => {
    setSettings((s) => {
      const overrides = { ...s.planClassOverrides };
      if (cls) {
        overrides[`${pid}|${plan}`] = cls;
      } else {
        delete overrides[`${pid}|${plan}`];
      }
      return { ...s, planClassOverrides: overrides };
    });
  }, []);

  const { rules } = settings;
  const latest = lastCompleteDay(nowSec);
  const asOf = settings.asOf ? parseIsoDay(settings.asOf) : latest;
  // Whole days, as the engine and the plan count them.
  const outcomeAfter = ruleDays(rules.outcomeDays) + graceDays(rules.labelGraceDays);
  const backtestTo = settings.backtestTo ? parseIsoDay(settings.backtestTo) : latest - outcomeAfter * DAY;
  const backtestFrom = settings.backtestFrom
    ? parseIsoDay(settings.backtestFrom)
    : backtestTo - 3 * ruleDays(rules.backtestStepDays) * DAY;

  const planned = useMemo((): { plan?: ScanPlan; backtest?: { from: number; to: number }; error?: string } => {
    const backtest = settings.mode === 'backtest' ? { from: backtestFrom, to: backtestTo } : undefined;
    try {
      return { plan: planScan(rules, settings.mode, asOf, backtest, nowSec), backtest };
    } catch (e) {
      return { error: errorText(e) };
    }
  }, [rules, settings.mode, asOf, backtestFrom, backtestTo, nowSec]);
  const { plan } = planned;

  const scopeEmpty = Array.isArray(scope) && scope.length === 0;
  const estimateKey =
    datasource && plan && !scopeEmpty ? JSON.stringify([datasource.uid, scope, plan.full, plan.light]) : '';
  const currentEstimate = estimate?.key === estimateKey ? estimate : undefined;
  const tooLarge = Boolean(currentEstimate?.value?.tooLarge);

  // The size estimate (daily aggregates, cheap) for the inputs on screen,
  // once they settle. Only while the section is shown and idle.
  const inputsRef = useRef({ datasource, scope, plan });
  inputsRef.current = { datasource, scope, plan };
  useEffect(() => {
    const { datasource: ds, scope: pids, plan: p } = inputsRef.current;
    if (!active || running || !estimateKey || !ds || !p || estimateRef.current?.key === estimateKey) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setEstimate({ key: estimateKey, loading: true, value: null });
      estimateScan(ds, pids, p, controller.signal)
        .catch(() => null)
        .then((value) => {
          if (!controller.signal.aborted) {
            setEstimate({ key: estimateKey, loading: false, value });
          }
        });
    }, ESTIMATE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
      // An estimate cut short is not an answer: ask again next time.
      if (estimateRef.current?.key === estimateKey && estimateRef.current.loading) {
        setEstimate(undefined);
      }
    };
  }, [active, running, estimateKey]);

  const behaviorOn = ga4 === 'on';
  const canRun = Boolean(datasource && plan) && !scopeEmpty && !tooLarge && !running;

  const engineOptions = useMemo((): { options?: KeepEngineOptions; error?: string } => {
    try {
      return {
        options: {
          planClassOverrides: settings.planClassOverrides,
          deliveryByPid: parseDeliveryByPid(settings.deliveryByPid),
        },
      };
    } catch (e) {
      return { error: errorText(e) };
    }
  }, [settings.planClassOverrides, settings.deliveryByPid]);
  const engineConfig = JSON.stringify([rules, engineOptions.options]);

  // What the held engine saves the next run: days it already holds, or
  // nothing when other rules need a new engine that cannot share them.
  const heldEngine = engineRef.current;
  const sameScope = Boolean(heldEngine && datasource && heldEngine.key === engineKey(datasource.uid ?? '', scope));
  const reusable = sameScope && (heldEngine?.config === engineConfig || Boolean(heldEngine?.engine.withSettings));
  const heldDays =
    reusable && heldEngine && plan
      ? plan.full.filter((d) => heldEngine.engine.hasDay(d, 'full')).length +
        plan.light.filter((d) => heldEngine.engine.hasDay(d, 'light')).length
      : 0;
  const reread = sameScope && !reusable;

  /** The engine for this scope and these rules: the held one when possible, so its days are not read again. */
  const engineFor = (key: string, engineRules: KeepRules, options: KeepEngineOptions): KeepEngineApi => {
    const config = JSON.stringify([engineRules, options]);
    const held = engineRef.current;
    let engine: KeepEngineApi;
    if (held && held.key === key) {
      if (held.config === config) {
        return held.engine;
      }
      engine = held.engine.withSettings?.(engineRules, options) ?? new KeepEngine(engineRules, options);
    } else {
      engine = new KeepEngine(engineRules, options);
    }
    engineRef.current = { key, config, engine };
    return engine;
  };

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const start = () => {
    if (!datasource || !plan) {
      return;
    }
    if (!engineOptions.options) {
      setError(engineOptions.error);
      return;
    }
    const engine = engineFor(engineKey(datasource.uid ?? '', scope), rules, engineOptions.options);
    const run: KeepRun = {
      engine,
      datasource,
      pids: scope,
      mode: settings.mode,
      asOf,
      backtest: planned.backtest,
      useBehavior: settings.useBehavior && behaviorOn,
      plan,
      estimateKey,
      sizeChecked: false,
    };
    reportInteraction('analytix_ai_keep_run', {
      mode: run.mode,
      fullDays: plan.full.length,
      lightDays: plan.light.length,
      behavior: run.useBehavior,
    });
    execute(run);
  };

  /** Continues a run that a failure or "Stop" cut short, with the days it already read. */
  const resume = () => {
    if (resumable) {
      reportInteraction('analytix_ai_keep_resume');
      execute(resumable);
    }
  };

  const execute = async (initial: KeepRun) => {
    let run = initial;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    let finished = false;
    setResumable(undefined);
    setError(undefined);
    setWarnings([]);
    setRunning(true);
    setProgress(undefined);
    setRunScope({ datasource: run.datasource, pids: run.pids });
    try {
      if (!run.sizeChecked) {
        const known = estimateRef.current;
        let size: ScanEstimate | null;
        if (known && known.key === run.estimateKey && !known.loading) {
          size = known.value;
        } else {
          setProgress({ phase: 'estimate', done: 0, total: 0 });
          size = await estimateScan(run.datasource, run.pids, run.plan, signal);
          if (signal.aborted) {
            return;
          }
          setEstimate({ key: run.estimateKey, loading: false, value: size });
        }
        if (size?.tooLarge) {
          // Refused before reading anything: nothing to continue.
          finished = true;
          setProgress(undefined);
          setError(tooLargeText(size));
          return;
        }
        run = { ...run, sizeChecked: true };
      }
      const snapshot = await runKeepScan({
        datasource: run.datasource,
        pids: run.pids,
        engine: run.engine,
        mode: run.mode,
        asOf: run.asOf,
        backtest: run.backtest,
        useBehavior: run.useBehavior,
        signal,
        onProgress: (p) => {
          if (!signal.aborted) {
            setProgress(p);
          }
        },
        onWarning: (message) => {
          if (!signal.aborted) {
            setWarnings((w) => [...w, message]);
          }
        },
      });
      finished = true;
      if (!signal.aborted) {
        setResult({ snapshot, rules: run.engine.rules });
      }
    } catch (e) {
      if (!signal.aborted) {
        setError(
          t(
            'ai-insider-alerts.keep.run-stopped',
            'The run stopped: {{error}} "Continue" picks it up with the days read so far.',
            { error: errorText(e), ...RAW }
          )
        );
      }
    } finally {
      if (abortRef.current === controller) {
        setRunning(false);
        if (!finished && !unmountedRef.current) {
          setResumable(run);
        }
      }
    }
  };

  const modeOptions = [
    { label: t('ai-insider-alerts.keep.mode-scan', 'Scan'), value: 'scan' as const },
    { label: t('ai-insider-alerts.keep.mode-backtest', 'Backtest'), value: 'backtest' as const },
  ];

  const ga4Reason =
    ga4 === 'loading'
      ? t('ai-insider-alerts.keep.ga4-checking', 'Checking the AI Insider service…')
      : ga4 === 'on'
        ? t('ai-insider-alerts.keep.ga4-available', 'App behavior of the at-risk customers, recent window only')
        : ga4 === 'unreachable'
          ? t('ai-insider-alerts.keep.ga4-unreachable', 'The AI Insider service is unreachable')
          : ga4 === 'misconfigured'
            ? t('ai-insider-alerts.keep.ga4-misconfigured', 'GA4 is assigned but unreachable right now')
            : ga4 === 'unavailable'
              ? t('ai-insider-alerts.keep.ga4-not-offered', 'GA4 evidence is not offered yet')
              : t('ai-insider-alerts.keep.ga4-not-connected', 'GA4 is not connected for this organisation');

  const pct =
    progress &&
    progress.total > 0 &&
    (progress.phase === 'days' || (progress.phase === 'evaluate' && progress.total > 1))
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : undefined;

  return (
    <div className={styles.page}>
      <p className={styles.intro}>
        <Trans i18nKey="ai-insider-alerts.keep.intro">
          Finds subscribers who drift away (watching less, gone quiet, a subscription ending or ended, refused
          playbacks) and turns each into a ready job: the reason, the action, when to send it and through which channel.
          Nothing is sent: export the jobs for the team. Backtest past days to see whether the rules find real risk.
        </Trans>
      </p>

      <section className={styles.card}>
        <div className={styles.controls}>
          <Field label={t('ai-insider-alerts.keep.mode', 'Mode')} className={styles.field} noMargin>
            <RadioButtonGroup
              options={modeOptions}
              value={settings.mode}
              onChange={(mode) => update({ mode })}
              disabled={running}
            />
          </Field>
          {settings.mode === 'scan' ? (
            <Field
              label={t('ai-insider-alerts.keep.as-of', 'As of (UTC day)')}
              description={t('ai-insider-alerts.keep.as-of-desc', 'latest complete: {{day}}', { day: isoDay(latest) })}
              className={styles.field}
              noMargin
            >
              <Input
                type="date"
                value={settings.asOf || isoDay(latest)}
                max={isoDay(latest)}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  // The latest day is stored as "latest", so it moves on by itself tomorrow.
                  update({ asOf: value === isoDay(latest) ? '' : value });
                }}
                disabled={running}
              />
            </Field>
          ) : (
            <>
              <Field
                label={t('ai-insider-alerts.keep.backtest-from', 'First as-of (UTC)')}
                className={styles.field}
                noMargin
              >
                <Input
                  type="date"
                  value={settings.backtestFrom || (Number.isFinite(backtestFrom) ? isoDay(backtestFrom) : '')}
                  onChange={(e) => update({ backtestFrom: e.currentTarget.value })}
                  disabled={running}
                />
              </Field>
              <Field
                label={t('ai-insider-alerts.keep.backtest-to', 'Last as-of (UTC)')}
                description={t('ai-insider-alerts.keep.backtest-to-desc', 'needs {{days}} days of outcome after it', {
                  days: outcomeAfter,
                })}
                className={styles.field}
                noMargin
              >
                <Input
                  type="date"
                  value={settings.backtestTo || (Number.isFinite(backtestTo) ? isoDay(backtestTo) : '')}
                  onChange={(e) => update({ backtestTo: e.currentTarget.value })}
                  disabled={running}
                />
              </Field>
            </>
          )}
          <Field
            label={t('ai-insider-alerts.keep.delivery', 'Delivery per provider')}
            description={t(
              'ai-insider-alerts.keep.delivery-desc',
              'push, crm or none per provider id; others: not set'
            )}
            className={styles.wideField}
            noMargin
          >
            <Input
              placeholder={t('ai-insider-alerts.keep.delivery-placeholder', '111=crm, 222=push')}
              value={settings.deliveryByPid}
              onChange={(e) => update({ deliveryByPid: e.currentTarget.value })}
              disabled={running}
            />
          </Field>
          <Field
            label={t('ai-insider-alerts.keep.ga4', 'GA4 evidence')}
            description={ga4Reason}
            className={styles.field}
            noMargin
          >
            <Switch
              value={settings.useBehavior && behaviorOn}
              onChange={(e) => update({ useBehavior: e.currentTarget.checked })}
              disabled={running || !behaviorOn}
            />
          </Field>
          <div className={styles.actions}>
            {running ? (
              <Button variant="destructive" icon="square-shape" onClick={stop}>
                <Trans i18nKey="ai-insider-alerts.keep.stop">Stop</Trans>
              </Button>
            ) : (
              <Button icon={settings.mode === 'scan' ? 'play' : 'history'} onClick={start} disabled={!canRun}>
                {settings.mode === 'scan'
                  ? t('ai-insider-alerts.keep.run-scan', 'Run scan')
                  : t('ai-insider-alerts.keep.run-backtest', 'Run backtest')}
              </Button>
            )}
            {!running && resumable && (
              <Button
                variant="secondary"
                icon="arrow-right"
                onClick={resume}
                tooltip={t(
                  'ai-insider-alerts.keep.continue-tip',
                  'Continues the stopped run on {{datasource}} with its providers ({{pids}}) and rules; days already read are not read again',
                  { datasource: datasourceName(resumable.datasource), pids: scopePids(resumable.pids), ...RAW }
                )}
              >
                <Trans i18nKey="ai-insider-alerts.keep.continue">Continue</Trans>
              </Button>
            )}
          </div>
        </div>

        <Collapse
          label={t('ai-insider-alerts.keep.rules', 'Retention rules')}
          isOpen={rulesOpen}
          onToggle={() => setRulesOpen((o) => !o)}
          collapsible
        >
          <div className={styles.rules}>
            {ruleFields().map((f) => (
              <Field key={f.key} label={f.label} description={f.description} className={styles.field} noMargin>
                {f.kind === 'boolean' ? (
                  <Checkbox
                    value={Boolean(rules[f.key])}
                    onChange={(e) => updateRule(f.key, e.currentTarget.checked)}
                    disabled={running}
                  />
                ) : f.kind === 'text' ? (
                  <Input
                    value={String(rules[f.key])}
                    onChange={(e) => updateRule(f.key, e.currentTarget.value)}
                    disabled={running}
                  />
                ) : (
                  <Input
                    id={`keep-rule-${f.key}`}
                    type="number"
                    min={f.min ?? 0}
                    max={f.max}
                    step={f.step ?? 1}
                    suffix={f.unit || undefined}
                    value={f.kind === 'percent' ? Math.round(Number(rules[f.key]) * 100) : Number(rules[f.key])}
                    onChange={(e) => {
                      const typed = Number(e.currentTarget.value);
                      const n = f.integer ? Math.round(typed) : typed;
                      if (Number.isFinite(n) && n >= (f.min ?? 0)) {
                        const capped = Math.min(f.max ?? Infinity, n);
                        updateRule(f.key, f.kind === 'percent' ? Math.min(100, capped) / 100 : capped);
                      }
                    }}
                    disabled={running}
                  />
                )}
              </Field>
            ))}
            <div className={styles.actions}>
              <Button
                variant="secondary"
                fill="text"
                onClick={() => update({ rules: DEFAULT_KEEP_RULES })}
                disabled={running}
              >
                <Trans i18nKey="ai-insider-alerts.keep.rules-reset">Reset to defaults</Trans>
              </Button>
            </div>
          </div>
        </Collapse>

        {plan && !running && !scopeEmpty && datasource && (
          <div className={tooLarge ? styles.error : styles.status}>
            {estimateLine(plan, currentEstimate, heldDays, reread)}
          </div>
        )}
        {(running || progress) && (
          <div className={styles.status}>
            {running && <Spinner inline />}
            <span>{progressText(progress)}</span>
            {pct !== undefined && (
              <div className={styles.bar}>
                <div className={styles.barFill} style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>
        )}
        {running && runScope && <div className={styles.scope}>{runScopeText(runScope.datasource, runScope.pids)}</div>}
        {planned.error && <div className={styles.error}>{planned.error}</div>}
        {error && (
          <Alert severity="error" title={t('ai-insider-alerts.keep.error-title', 'Scan failed')}>
            {error}
          </Alert>
        )}
        {warnings.map((w, i) => (
          <div key={i} className={styles.warning}>
            {w}
          </div>
        ))}
      </section>

      {result && (
        <KeepResults
          snapshot={result.snapshot}
          rules={result.rules}
          includeTitles={settings.includeTitles}
          onIncludeTitlesChange={(includeTitles) => update({ includeTitles })}
          planClassOverrides={settings.planClassOverrides}
          onPlanClassChange={onPlanClassChange}
          onExport={(kind, rows) => reportInteraction('analytix_ai_keep_export', { kind, rows })}
        />
      )}
    </div>
  );
}

function tooLargeText(size: ScanEstimate): string {
  return t(
    'ai-insider-alerts.keep.too-large',
    'Too large: ≈{{accountDays}} account-days, the limit is {{limit}}. Narrow the providers, the windows or the backtest.',
    { accountDays: formatCount(size.accountDays), limit: formatCount(KEEP_MAX_ACCOUNT_DAYS) }
  );
}

function estimateLine(plan: ScanPlan, estimate: EstimateState | undefined, heldDays: number, reread: boolean): string {
  const days = [
    t('ai-insider-alerts.keep.estimate-days', '{{full}} full + {{light}} light days', {
      full: plan.full.length,
      light: plan.light.length,
    }),
    heldDays > 0 ? t('ai-insider-alerts.keep.estimate-held', '{{held}} already read', { held: heldDays }) : '',
    reread ? t('ai-insider-alerts.keep.estimate-reread', 'other rules or delivery: all days are read again') : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (!estimate || estimate.loading) {
    return `${days} · ${t('ai-insider-alerts.keep.estimating', 'estimating the size…')}`;
  }
  if (!estimate.value) {
    return `${days} · ${t('ai-insider-alerts.keep.estimate-unavailable', 'size estimate unavailable; the scan can still run')}`;
  }
  if (estimate.value.tooLarge) {
    return tooLargeText(estimate.value);
  }
  return `${days} · ${t(
    'ai-insider-alerts.keep.estimate',
    '≈{{accounts}} accounts/day · {{accountDays}} account-days',
    {
      accounts: formatCount(estimate.value.accountsPerDay),
      accountDays: formatCount(estimate.value.accountDays),
    }
  )}`;
}

function progressText(progress: KeepProgress | undefined): string {
  switch (progress?.phase) {
    case 'estimate':
      return t('ai-insider-alerts.keep.progress-estimate', 'Estimating the scan size…');
    case 'days':
      return progress.day === undefined
        ? t('ai-insider-alerts.keep.progress-days', 'Reading days: {{done}} of {{total}}', {
            done: progress.done,
            total: progress.total,
          })
        : t('ai-insider-alerts.keep.progress-day', 'Reading day {{n}} of {{total}} ({{day}})', {
            n: Math.min(progress.done + 1, progress.total),
            total: progress.total,
            day: isoDay(progress.day),
          });
    case 'evaluate':
      return progress.total > 1
        ? t(
            'ai-insider-alerts.keep.progress-evaluate-dates',
            'Applying the rules: {{done}} of {{total}} as-of dates done…',
            {
              done: progress.done,
              total: progress.total,
            }
          )
        : t('ai-insider-alerts.keep.progress-evaluate', 'Applying the rules…');
    case 'behavior':
      return t('ai-insider-alerts.keep.progress-behavior', 'Asking for GA4 evidence ({{done}} of {{total}} batches)…', {
        done: progress.done,
        total: progress.total,
      });
    case 'done':
      return t('ai-insider-alerts.keep.progress-done', 'Done: {{total}} days', { total: progress.total });
    default:
      return t('ai-insider-alerts.keep.progress-start', 'Starting…');
  }
}

const getStyles = (theme: GrafanaTheme2) => ({
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
  wideField: css({
    minWidth: 240,
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
