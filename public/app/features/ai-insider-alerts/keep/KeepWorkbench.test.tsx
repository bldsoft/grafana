// Analytix: AI Insider Alerts — the page with both sections: shared scope,
// section switch, and the Keep workbench driving a (mocked) scan.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from 'test/test-utils';

import { DataSourceRef } from '@grafana/data';
import { locationService } from '@grafana/runtime';

import AlertsPage from '../AlertsPage';

import { lastCompleteDay } from './runner';
import { isoDay } from './text';
import { DEFAULT_KEEP_RULES, KeepSnapshot } from './types';

const runKeepScan = jest.fn();
const estimateScan = jest.fn();
const runReplay = jest.fn();
const reportInteraction = jest.fn();

jest.mock('app/features/dashboard-scene/ai-panel/useAiInsiderAccess', () => ({
  useAiInsiderAccessState: () => ({ allowed: true, loading: false, providerIds: '111,222' }),
}));

jest.mock('app/features/dashboard-scene/ai-panel/assistantClient', () => ({
  fetchCapabilities: () => Promise.resolve([{ id: 'behavior', status: 'on', properties: [] }]),
  fetchKeepBehavior: jest.fn(),
}));

jest.mock('@grafana/runtime', () => {
  const actual = jest.requireActual('@grafana/runtime');
  const overrides: Record<string, unknown> = {
    getDataSourceSrv: () => ({
      getList: () => [{ uid: 'ch', type: 'grafana-clickhouse-datasource', name: 'CH' }],
      getInstanceSettings: (ref: DataSourceRef) => (ref?.uid === 'ch' ? { uid: 'ch', name: 'CH' } : undefined),
    }),
    DataSourcePicker: () => <div>picker</div>,
    reportInteraction: (...args: unknown[]) => reportInteraction(...args),
  };
  return new Proxy(actual, { get: (target, prop: string) => (prop in overrides ? overrides[prop] : target[prop]) });
});

jest.mock('./runner', () => ({
  ...jest.requireActual('./runner'),
  runKeepScan: (...args: unknown[]) => runKeepScan(...args),
  estimateScan: (...args: unknown[]) => estimateScan(...args),
}));

jest.mock('../runner', () => ({
  ...jest.requireActual('../runner'),
  runReplay: (...args: unknown[]) => runReplay(...args),
}));

const DAY = 86400;

function emptySnapshot(asOf: number, pids: string[] | null): KeepSnapshot {
  return {
    asOf,
    pids,
    assessments: [],
    jobs: [],
    renewals: [],
    leads: [],
    support: [],
    quality: {
      accounts: 5,
      eligible: 3,
      legacyOnly: 0,
      planUnknown: 0,
      expiryUnknown: 0,
      noEnd: 0,
      plans: [],
      renewalStyles: { at_term: 0, early: 0, repurchase: 0, unknown: 0 },
      paywall: [],
      days: [],
      missingDays: [],
    },
    mdePct: null,
  };
}

/** Runs until "Stop" (its signal aborts). */
const untilStopped = (opts: { signal: AbortSignal }) =>
  new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('stopped'))));

/** Elements with this text that are on screen (the other section stays mounted, hidden). */
const shown = (text: string | RegExp) => screen.queryAllByText(text).filter((el) => !el.closest('[hidden]'));

beforeEach(() => {
  window.localStorage.clear();
  runKeepScan.mockReset();
  estimateScan.mockReset();
  runReplay.mockReset();
  reportInteraction.mockReset();
});

describe('AlertsPage with Keep the customer', () => {
  it('switches sections and runs a scan', async () => {
    window.localStorage.setItem(
      'analytix.aiAlerts.settings.v1',
      JSON.stringify({ datasourceUid: 'ch', providers: '111', mode: 'replay', step: 900 })
    );
    estimateScan.mockResolvedValue({ perPid: [], accountsPerDay: 1000, accountDays: 40000, tooLarge: false });
    runKeepScan.mockImplementation(async (opts) => {
      opts.onProgress({ phase: 'days', done: 1, total: 40, day: opts.asOf });
      return emptySnapshot(opts.asOf, opts.pids);
    });
    const { user } = render(<AlertsPage />, { renderWithRouter: true });

    expect(screen.getByRole('tab', { name: 'Tell the customer' })).toHaveAttribute('aria-selected', 'true');
    // Migrated scope.
    expect(screen.getByDisplayValue('111')).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem('analytix.aiAlerts.common.v1')!)).toEqual({
      datasourceUid: 'ch',
      providers: '111',
    });
    expect(JSON.parse(window.localStorage.getItem('analytix.aiAlerts.settings.v1')!).providers).toBeUndefined();
    expect(screen.getByText('Run replay')).toBeVisible();

    await user.click(screen.getByRole('tab', { name: 'Keep the customer' }));
    expect(locationService.getSearchObject().section).toBe('keep');
    expect(screen.getByText('Run scan')).toBeVisible();
    expect(screen.getByText('Run replay')).not.toBeVisible();
    await waitFor(() => expect(estimateScan).toHaveBeenCalled());
    await screen.findByText(/≈1,000 accounts\/day · 40,000 account-days/);
    await user.click(screen.getByText('Retention rules'));
    expect(screen.getByText('Control group salt')).toBeInTheDocument();

    await user.click(screen.getByText('Run scan'));
    await screen.findByText('Ready jobs');
    expect(runKeepScan).toHaveBeenCalledWith(
      expect.objectContaining({ pids: ['111'], mode: 'scan', useBehavior: false })
    );
    expect(runKeepScan.mock.calls[0][0].engine.rules).toEqual(DEFAULT_KEEP_RULES);
    expect(reportInteraction).toHaveBeenCalledWith('analytix_ai_keep_run', expect.anything());
    expect(screen.getByText(/customers seen, 3 judged/)).toBeInTheDocument();

    // Second run on the same scope and rules: the same engine (its days are kept).
    const firstEngine = runKeepScan.mock.calls[0][0].engine;
    await user.click(screen.getByText('Run scan'));
    await waitFor(() => expect(runKeepScan).toHaveBeenCalledTimes(2));
    expect(runKeepScan.mock.calls[1][0].engine).toBe(firstEngine);
    // Other rules: an engine over the same held days (withSettings), so nothing is read again.
    const recent = screen.getAllByDisplayValue('7')[0];
    await user.tripleClick(recent);
    await user.keyboard('6');
    await user.click(screen.getByText('Run scan'));
    await waitFor(() => expect(runKeepScan).toHaveBeenCalledTimes(3));
    expect(runKeepScan.mock.calls[2][0].engine).not.toBe(firstEngine);
    expect(runKeepScan.mock.calls[2][0].engine.rules.recentDays).toBe(6);
    expect(screen.queryByText(/all days are read again/)).not.toBeInTheDocument();
    await user.tripleClick(recent);
    await user.keyboard('7');
    // The size check of the restored plan runs after its debounce; let it land.
    await screen.findByText(/≈1,000 accounts\/day · 40,000 account-days/, undefined, { timeout: 3000 });

    // A failed run can be continued with the same engine, without a new size check.
    runKeepScan.mockRejectedValueOnce(new Error('Could not read 2026-10-01'));
    estimateScan.mockClear();
    await user.click(screen.getByText('Run scan'));
    await screen.findByText(/The run stopped: Could not read 2026-10-01/);
    await user.click(screen.getByText('Continue'));
    await waitFor(() => expect(runKeepScan).toHaveBeenCalledTimes(5));
    expect(runKeepScan.mock.calls[4][0].engine).toBe(runKeepScan.mock.calls[3][0].engine);
    expect(estimateScan).not.toHaveBeenCalled();

    // Too large: refused before reading.
    await user.clear(screen.getByDisplayValue('111'));
    await user.type(screen.getByPlaceholderText('Empty = all in scope, or ids: 111, 222'), '222');
    estimateScan.mockResolvedValue({ perPid: [], accountsPerDay: 200000, accountDays: 8000000, tooLarge: true });
    await screen.findByText(/Too large: ≈8,000,000 account-days/, undefined, { timeout: 3000 });
    expect(screen.getByText('Run scan').closest('button')).toBeDisabled();

    await user.click(screen.getByRole('tab', { name: 'Tell the customer' }));
    expect(locationService.getSearchObject().section).toBeUndefined();
  });

  it('shows the scope each running section holds, whatever the shared bar shows meanwhile', async () => {
    window.localStorage.setItem(
      'analytix.aiAlerts.common.v1',
      JSON.stringify({ datasourceUid: 'ch', providers: '111' })
    );
    window.localStorage.setItem('analytix.aiAlerts.settings.v1', JSON.stringify({ mode: 'replay', step: 900 }));
    estimateScan.mockResolvedValue({ perPid: [], accountsPerDay: 1000, accountDays: 40000, tooLarge: false });
    runReplay.mockImplementation(untilStopped);
    runKeepScan.mockImplementation((opts) => {
      opts.onProgress({ phase: 'evaluate', done: 2, total: 4 });
      return untilStopped(opts);
    });
    const { user } = render(<AlertsPage />, { renderWithRouter: true });

    // Tell: a replay on 111.
    await user.click(screen.getByText('Run replay'));
    await waitFor(() => expect(runReplay).toHaveBeenCalled());
    expect(runReplay.mock.calls[0][0].pids).toEqual(['111']);
    expect(shown('Running on CH · providers 111')).toHaveLength(1);

    // Keep is idle, so the bar unlocks there: the scope changes to 222.
    await user.click(screen.getByRole('tab', { name: /^Keep the customer/ }));
    await user.clear(screen.getByDisplayValue('111'));
    await user.type(screen.getByPlaceholderText('Empty = all in scope, or ids: 111, 222'), '222');
    await user.click(screen.getByText('Run scan'));
    await waitFor(() => expect(runKeepScan).toHaveBeenCalled());
    expect(runKeepScan.mock.calls[0][0].pids).toEqual(['222']);
    expect(shown('Running on CH · providers 222')).toHaveLength(1);
    // The backtest goes date by date.
    expect(shown('Applying the rules: 2 of 4 as-of dates done…')).toHaveLength(1);

    // Back on Tell: the locked bar shows 222, the replay still reads 111 and says so.
    await user.click(screen.getByRole('tab', { name: /^Tell the customer/ }));
    expect(screen.getByDisplayValue('222')).toBeDisabled();
    expect(shown('Running on CH · providers 111')).toHaveLength(1);
    expect(shown(/Running on CH · providers 222/)).toHaveLength(0);

    // Stopped runs name the datasource and providers they continue with.
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await user.hover(await screen.findByRole('button', { name: 'Continue replay' }));
    expect(
      await screen.findByText(/Continues the stopped replay on CH from .* with its original providers \(111\)/)
    ).toBeInTheDocument();
    expect(shown(/Running on/)).toHaveLength(0);

    await user.click(screen.getByRole('tab', { name: /^Keep the customer/ }));
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await user.hover(await screen.findByRole('button', { name: 'Continue' }));
    expect(
      await screen.findByText(
        'Continues the stopped run on CH with its providers (222) and rules; days already read are not read again'
      )
    ).toBeInTheDocument();
  });

  it('keeps the day rules whole and within reach, and counts them as the engine does', async () => {
    window.localStorage.setItem(
      'analytix.aiAlerts.common.v1',
      JSON.stringify({ datasourceUid: 'ch', providers: '111' })
    );
    // Saved before the limits: fractional outcome and grace days.
    window.localStorage.setItem(
      'analytix.aiAlerts.keep.v1',
      JSON.stringify({ mode: 'backtest', rules: { ...DEFAULT_KEEP_RULES, outcomeDays: 0.5, labelGraceDays: 2.7 } })
    );
    estimateScan.mockResolvedValue({ perPid: [], accountsPerDay: 1000, accountDays: 40000, tooLarge: false });
    const { user } = render(<AlertsPage />, { renderWithRouter: true });
    await user.click(screen.getByRole('tab', { name: /^Keep the customer/ }));

    // 1 outcome day (the engine's least) + 2 whole grace days.
    expect(screen.getByText('needs 3 days of outcome after it')).toBeInTheDocument();
    const latest = lastCompleteDay(Math.floor(Date.now() / 1000));
    expect(screen.getByDisplayValue(isoDay(latest - 3 * DAY))).toBeInTheDocument();

    await user.click(screen.getByText('Retention rules'));
    const field = (label: RegExp) => screen.getByRole('spinbutton', { name: label });

    const outcome = field(/^Backtest: outcome within/);
    await user.tripleClick(outcome);
    await user.keyboard('75');
    expect(outcome).toHaveValue(60);
    // At least one day.
    await user.tripleClick(outcome);
    await user.keyboard('0');
    expect(outcome).toHaveValue(60);

    const grace = field(/^Backtest: grace for late renewals/);
    await user.tripleClick(grace);
    await user.keyboard('20');
    expect(grace).toHaveValue(14);
    expect(screen.getByText('needs 74 days of outcome after it')).toBeInTheDocument();

    // Whole days only.
    const baseline = field(/^Baseline window/);
    fireEvent.change(baseline, { target: { value: '13.6' } });
    expect(baseline).toHaveValue(14);

    const recent = field(/^Recent window/);
    await user.tripleClick(recent);
    await user.keyboard('40');
    expect(recent).toHaveValue(28);
    await user.tripleClick(recent);
    await user.keyboard('7');

    // A year of history is cut to 90 days; the plan then refuses the light days it would read.
    const history = field(/^Subscription history/);
    await user.tripleClick(history);
    await user.keyboard('400');
    expect(history).toHaveValue(90);
    expect(screen.getByText(/The run needs 143 light days, more than 90/)).toBeInTheDocument();
    expect(screen.getByText('Run backtest').closest('button')).toBeDisabled();
  });
});
