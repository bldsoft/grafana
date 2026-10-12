import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { KeepResults, KeepResultsProps } from './KeepResults';
import { AccountAssessment, DEFAULT_KEEP_RULES, KeepJob, KeepSnapshot, WindowStats } from './types';

const downloadBlob = jest.fn();

jest.mock('../export', () => ({
  downloadBlob: (...args: unknown[]) => downloadBlob(...args),
}));

const D = Date.UTC(2026, 9, 9) / 1000;
const DAY = 86400;

function stats(overrides: Partial<WindowStats> = {}): WindowStats {
  return {
    activeDays: 5,
    events: 300,
    legacyEvents: 0,
    gatedPlays: 20,
    ungatedPlays: 0,
    watchAllMin: 300,
    watchMin: 280,
    liveMin: 250,
    ondemandMin: 50,
    catchupMin: 0,
    distinctPerDay: 3,
    playbacks: 20,
    failedPlaybacks: 0,
    failedDays: 0,
    bufferingStops: 1,
    inactiveAttempts: 0,
    premiumAttempts: 0,
    premiumPaidContent: 0,
    searchSessions: 2,
    failedSearchSessions: 0,
    favAdded: 0,
    favRemoved: 0,
    appStarts: 10,
    ...overrides,
  };
}

function assessment(account: string, overrides: Partial<AccountAssessment> = {}): AccountAssessment {
  return {
    key: `111|${account}`,
    pid: '111',
    account,
    accountKey: account.replace(/-/g, ''),
    eligible: true,
    atRisk: true,
    baselinePlan: 'Premium Monthly',
    latestPlan: 'Premium Monthly',
    planClass: 'paid',
    org: '',
    subscriptionId: '',
    organisationId: '',
    expiry: D + 20 * DAY,
    noEnd: false,
    renewalStyle: 'at_term',
    deactivatedAt: null,
    deactivated: false,
    lastSeen: D + 20 * 3600,
    daysSinceLastSeen: 0,
    recent: stats({ watchAllMin: 70 }),
    baseline: stats({ activeDays: 18, watchAllMin: 1890 }),
    fadeRatio: null,
    dailyWatch: Array.from({ length: 28 }, (_, i) => (i < 21 ? 90 : 10)),
    platforms: ['AndroidTV'],
    signalCoverage: 'full',
    evidence: [],
    techIssue: false,
    topErrCode: '',
    seeds: [],
    peakHour: 20,
    tzOffsetH: 2,
    ...overrides,
  };
}

function job(account: string, overrides: Partial<KeepJob> = {}): KeepJob {
  return {
    id: `job-${account}`,
    key: `111|${account}`,
    pid: '111',
    account,
    accountKey: account.replace(/-/g, ''),
    reason: 'price',
    action: 'retention_offer',
    offerKind: 'win_back',
    offerStep: 1,
    offerTool: 'payment_link',
    delivery: 'crm',
    priority: 78,
    tier: 'high',
    priorityParts: { severity: 1, urgency: 0.8, value: 0.5 },
    sendAt: D + DAY + 8 * 3600,
    steps: [{ at: D + DAY + 8 * 3600, channel: 'crm', what: 'payment_link' }],
    dueBy: null,
    seeds: [],
    profileIds: ['p1'],
    recEndpoint: 'tvchannels',
    recFallback: true,
    techIssue: false,
    control: false,
    deferred: false,
    evidence: [],
    expiry: D - 4 * DAY,
    plan: 'Premium Monthly',
    renewalStyle: 'at_term',
    consent: 'unknown',
    ...overrides,
  };
}

function snapshot(overrides: Partial<KeepSnapshot> = {}): KeepSnapshot {
  const seeds = [{ profileId: 'p7', contentType: 'tv', contentId: '20002549', title: 'Sport 1', minutes: 600 }];
  const tech = assessment('EE-999-003', {
    techIssue: true,
    topErrCode: '403/1001',
    recent: stats({ playbacks: 20, failedPlaybacks: 8 }),
    evidence: [{ code: 'TECH_ERRORS', value: 0.4, label: '403/1001' }],
  });
  return {
    asOf: D,
    pids: ['111'],
    assessments: [
      assessment('AA-123-456', { evidence: [{ code: 'LAPSED', value: 4 }] }),
      assessment('CC-555-001', { seeds }),
      assessment('DD-777-002'),
      tech,
    ],
    jobs: [
      job('CC-555-001', {
        reason: 'content',
        action: 'content_push',
        offerKind: undefined,
        offerStep: undefined,
        offerTool: 'none',
        delivery: 'unset',
        priority: 50,
        tier: 'medium',
        seeds,
        profileIds: ['p7'],
        recFallback: false,
        evidence: [
          { code: 'FADING', value: 0.25, ref: 90 },
          { code: 'DIVERSITY_DROP', value: 1.2, ref: 4.5 },
        ],
      }),
      job('AA-123-456', {
        evidence: [
          { code: 'LAPSED', value: 4 },
          { code: 'INACTIVE_ATTEMPTS', value: 3 },
        ],
      }),
      job('DD-777-002', {
        reason: 'disengaged',
        action: 're_engagement',
        offerKind: undefined,
        offerStep: undefined,
        offerTool: 'none',
        delivery: 'push',
        priority: 40,
        tier: 'medium',
        control: true,
        evidence: [{ code: 'QUIET', value: 9 }],
      }),
      job('EE-999-003', {
        reason: 'technical',
        action: 'support',
        offerKind: undefined,
        offerStep: undefined,
        offerTool: 'none',
        delivery: 'push',
        priority: 60,
        tier: 'high',
        techIssue: true,
        evidence: [{ code: 'TECH_ERRORS', value: 0.4, label: '403/1001' }],
      }),
    ],
    renewals: [
      {
        key: '111|CC-555-001',
        pid: '111',
        account: 'CC-555-001',
        expiry: D + 3 * DAY + 3600,
        renewalStyle: 'repurchase',
        atRisk: true,
        kind: 'at_risk',
        plan: 'Premium Monthly',
      },
      {
        key: '111|FF-100-001',
        pid: '111',
        account: 'FF-100-001',
        expiry: D + 3 * DAY + 7200,
        renewalStyle: 'at_term',
        atRisk: false,
        kind: 'check_autopay',
        plan: 'Premium Monthly',
      },
      {
        key: '111|GG-200-002',
        pid: '111',
        account: 'GG-200-002',
        expiry: D - 5 * DAY,
        renewalStyle: 'unknown',
        atRisk: false,
        kind: 'expired_silent',
        plan: 'Premium Monthly',
      },
    ],
    leads: [
      assessment('HH-300-003', {
        atRisk: false,
        recent: stats({ premiumAttempts: 5, premiumPaidContent: 1 }),
        evidence: [{ code: 'PREMIUM_ATTEMPTS', value: 4, label: 'Champions League' }],
      }),
    ],
    support: [tech],
    quality: {
      accounts: 1200,
      eligible: 900,
      legacyOnly: 80,
      planUnknown: 15,
      expiryUnknown: 100,
      noEnd: 12,
      plans: [
        { pid: '111', plan: 'Premium Monthly', planClass: 'paid', overridden: false, accounts: 700 },
        { pid: '111', plan: 'Free Trial', planClass: 'free', overridden: false, accounts: 50 },
      ],
      renewalStyles: { at_term: 300, early: 20, repurchase: 40, unknown: 540 },
      paywall: [
        { platform: 'iOS', code: '402/AE402', count: 10, kind: 'premium' },
        { platform: 'iOS', code: 'subsctiprionInActive/', count: 3, kind: 'inactive' },
        { platform: 'AndroidTV', code: '/103', count: 4, kind: 'candidate' },
      ],
      days: Array.from({ length: 28 }, (_, i) => ({ day: D - i * DAY, level: 'full' as const, rows: 900 })),
      missingDays: [],
    },
    mdePct: 12.5,
    ...overrides,
  };
}

function props(overrides: Partial<KeepResultsProps> = {}): KeepResultsProps {
  return {
    snapshot: snapshot(),
    rules: DEFAULT_KEEP_RULES,
    includeTitles: false,
    onIncludeTitlesChange: jest.fn(),
    planClassOverrides: {},
    onPlanClassChange: jest.fn(),
    onExport: jest.fn(),
    ...overrides,
  };
}

/** The value under a tile's label. */
const tileValue = (label: string) => screen.getByText(label, { selector: 'div' }).nextElementSibling?.textContent;

/** The account number in a list row (its first cell). */
const accountOf = (row: HTMLElement) => row.querySelector('td')?.textContent?.match(/^[A-Z]{2}-\d{3}-\d{3}/)?.[0];

describe('KeepResults', () => {
  beforeEach(() => downloadBlob.mockReset());

  it('sums up the scan in tiles', () => {
    render(<KeepResults {...props()} />);

    // Ready = treatment jobs with a channel: not the control group, not support, not "no channel set".
    expect(tileValue('Ready jobs')).toBe('1');
    expect(tileValue('Hot win-back')).toBe('1');
    expect(tileValue('Renewals at risk')).toBe('1');
    expect(tileValue('Check autopay')).toBe('1');
    expect(tileValue('No channel set')).toBe('1');
    expect(tileValue('Control group')).toBe('1');
    expect(screen.getByText('MDE ≈ 12.5 pp · 20% held out')).toBeInTheDocument();
    expect(screen.getByText('1 technical · 0 deactivated')).toBeInTheDocument();
    expect(tileValue('GA4 evidence')).toBe('Off');
  });

  it('lists the jobs by priority as sentences, the control group marked', () => {
    render(<KeepResults {...props()} />);

    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(5);
    expect(within(rows[1]).getByText('AA-123-456')).toBeInTheDocument();
    expect(
      within(rows[1]).getByText(
        'Subscription ended 4 d ago, still using the app · 3 playbacks refused: subscription not active'
      )
    ).toBeInTheDocument();
    expect(within(rows[1]).getByText('Win-back · step 1 · payment link')).toBeInTheDocument();
    expect(within(rows[1]).getByText('10:00 local (UTC+2)')).toBeInTheDocument();
    expect(within(rows[2]).getByText('EE-999-003')).toBeInTheDocument();
    // FADING is relative to the provider trend; now = the account's recent watch per day (70 min / 7 d).
    expect(
      within(rows[3]).getByText(
        'Watching 25% of usual, relative to the provider trend (now 10, was 90 min/day) · Distinct titles per day 1.2 (was 4.5)'
      )
    ).toBeInTheDocument();
    expect(within(rows[4]).getByText('Control')).toBeInTheDocument();
  });

  it('filters by action and delivery and finds an account', async () => {
    render(<KeepResults {...props()} />);

    await userEvent.click(screen.getByRole('radio', { name: 'Content push' }));
    let rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(2);
    expect(within(rows[1]).getByText('CC-555-001')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: 'All' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Push' }));
    rows = screen.getAllByRole('row');
    expect(rows.slice(1).map(accountOf)).toEqual(['EE-999-003', 'DD-777-002']);

    await userEvent.click(screen.getByRole('radio', { name: 'Any channel' }));
    // The account key without dashes finds it too.
    await userEvent.type(screen.getByPlaceholderText('Account'), 'aa123');
    rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(2);
    expect(within(rows[1]).getByText('AA-123-456')).toBeInTheDocument();
  });

  it('expands a job into its watch history, signals and seeds', async () => {
    render(<KeepResults {...props()} />);

    await userEvent.click(screen.getByText('CC-555-001'));
    expect(screen.getByText(/Watched minutes per UTC day, last 28 days/)).toBeInTheDocument();
    expect(screen.getByText('Recent 7 d')).toBeInTheDocument();
    expect(screen.getByText('Recommendations start from')).toBeInTheDocument();
    expect(screen.getByText('Sport 1')).toBeInTheDocument();
    expect(screen.getByText('tv 20002549 · 600 min · profile p7')).toBeInTheDocument();
  });

  it('asks before saving the hand-off, which leaves out control and support', async () => {
    const onExport = jest.fn();
    render(<KeepResults {...props({ onExport })} />);

    await userEvent.click(screen.getByRole('button', { name: /Export jobs CSV \(2\)/ }));
    expect(screen.getByText(/The file contains subscriber identifiers/)).toBeInTheDocument();
    expect(downloadBlob).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Save file' }));
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, name] = downloadBlob.mock.calls[0];
    expect(name).toBe('ai-insider-keep-jobs_2026-10-09.csv');
    const csv = await (blob as Blob).text();
    expect(csv).toContain('AA-123-456');
    expect(csv).toContain('CC-555-001');
    expect(csv).not.toContain('DD-777-002');
    expect(csv).not.toContain('EE-999-003');
    expect(onExport).toHaveBeenCalledWith('jobs', 2);
  });

  it('shows renewals by day and the expired-and-silent list', async () => {
    render(<KeepResults {...props()} />);

    await userEvent.click(screen.getByRole('tab', { name: /Renewals/ }));
    const day = screen.getByText('2026-10-12').closest('tr')!;
    // At risk, check autopay, then re-purchase / early / at term / unknown.
    expect([...day.querySelectorAll('td')].map((td) => td.textContent)).toEqual([
      '2026-10-12',
      '1',
      '1',
      '1',
      '',
      '1',
      '',
    ]);
    expect(screen.getByText('GG-200-002')).toBeInTheDocument();

    await userEvent.click(day);
    expect(screen.getByText('FF-100-001')).toBeInTheDocument();
  });

  it('shows leads and support hand-offs with their evidence', async () => {
    render(<KeepResults {...props()} />);

    await userEvent.click(screen.getByRole('tab', { name: /Leads/ }));
    expect(screen.getByText('4 playbacks refused: needs another package (Champions League)')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /Support/ }));
    expect(screen.getByText('40% of playbacks failed (code 403/1001)')).toBeInTheDocument();
    expect(screen.getByText('8/20')).toBeInTheDocument();
  });

  it('lets a wrong plan class be overridden', async () => {
    const onPlanClassChange = jest.fn();
    render(<KeepResults {...props({ onPlanClassChange, planClassOverrides: { '111|Premium Monthly': 'paid' } })} />);

    await userEvent.click(screen.getByRole('tab', { name: /Quality/ }));
    expect(screen.getByText('Customers seen').nextSibling?.textContent).toBe('1,200');
    const trial = screen.getByText('Free Trial').closest('tr')!;
    await userEvent.click(within(trial).getByRole('radio', { name: 'Paid' }));
    expect(onPlanClassChange).toHaveBeenCalledWith('111', 'Free Trial', 'paid');

    const premium = screen.getByText('Premium Monthly').closest('tr')!;
    expect(within(premium).getByRole('radio', { name: 'Paid' })).toBeChecked();
    await userEvent.click(within(premium).getByRole('radio', { name: 'By name' }));
    expect(onPlanClassChange).toHaveBeenLastCalledWith('111', 'Premium Monthly', undefined);
  });

  it('opens on the backtest report after a backtest', () => {
    render(
      <KeepResults
        {...props({
          snapshot: snapshot({
            backtest: {
              asOfs: [D - 14 * DAY, D - 7 * DAY, D],
              horizonDays: 21,
              suppressedByCooldown: 3,
              rows: [
                {
                  group: 'price',
                  flagged: 40,
                  labeled: 30,
                  censored: 10,
                  positiveRate: 0.5,
                  baseRate: 0.2,
                  lift: 2.5,
                  recall: 0.4,
                },
              ],
            },
          }),
        })}
      />
    );

    expect(screen.getByRole('tab', { name: /Backtest/ })).toHaveAttribute('aria-selected', 'true');
    const row = screen.getByText('Price (not renewed)').closest('tr')!;
    expect(within(row).getByText('2.5×')).toBeInTheDocument();
    expect(within(row).getByText('40%')).toBeInTheDocument();
    expect(within(row).getByText('25%')).toBeInTheDocument();
  });

  it('counts only deactivations inside the lookback on the support tile', () => {
    const base = snapshot();
    const tech = base.support[0];
    render(
      <KeepResults
        {...props({
          snapshot: snapshot({
            support: [
              // Refunded 35 days ago, re-subscribed since: technical, not deactivated in the window.
              { ...tech, deactivatedAt: D - 35 * DAY, deactivated: false },
              assessment('KK-400-004', {
                deactivatedAt: D - 3 * DAY,
                deactivated: true,
                evidence: [{ code: 'DEACTIVATED', value: D - 3 * DAY }],
              }),
            ],
          }),
        })}
      />
    );

    expect(screen.getByText('1 technical · 1 deactivated')).toBeInTheDocument();
  });

  it('says what the CSV holds when the list is cut', () => {
    const jobs = Array.from({ length: 310 }, (_, i) =>
      job(`AB-${String(i).padStart(3, '0')}-000`, { priority: 1000 - i, control: i % 31 === 0 })
    );
    render(<KeepResults {...props({ snapshot: snapshot({ jobs }) })} />);

    expect(screen.getAllByRole('row')).toHaveLength(301);
    // 10 of the 310 are in the control group: not in the CSV.
    expect(
      screen.getByText('Showing 300 of 310. The CSV holds 300 of them (no control, no support).')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export jobs CSV \(300\)/ })).toBeInTheDocument();
  });

  it('says the CSV has all jobs when it does', () => {
    const jobs = Array.from({ length: 301 }, (_, i) => job(`AB-${String(i).padStart(3, '0')}-000`));
    render(<KeepResults {...props({ snapshot: snapshot({ jobs }) })} />);

    expect(screen.getByText('Showing 300 of 301. Export the CSV for all.')).toBeInTheDocument();
  });

  it('marks the control group in the renewals, leads and support lists', async () => {
    // DD-777-002's job is in the control group (see snapshot()).
    const control = assessment('DD-777-002', {
      recent: stats({ premiumAttempts: 3, playbacks: 20, failedPlaybacks: 9 }),
      evidence: [{ code: 'PREMIUM_ATTEMPTS', value: 3 }],
    });
    const base = snapshot();
    render(
      <KeepResults
        {...props({
          snapshot: snapshot({
            renewals: [
              ...base.renewals,
              {
                key: '111|DD-777-002',
                pid: '111',
                account: 'DD-777-002',
                expiry: D + 3 * DAY + 600,
                renewalStyle: 'repurchase',
                atRisk: true,
                kind: 'at_risk',
                plan: 'Premium Monthly',
              },
            ],
            leads: [...base.leads, control],
            support: [...base.support, control],
          }),
        })}
      />
    );
    const badge = 'Control — do not contact';

    await userEvent.click(screen.getByRole('tab', { name: /Renewals/ }));
    expect(
      screen.getByText(/At risk: has a job, see the Jobs tab for its action; customers in the control group are marked/)
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Customers ending on 2026-10-12' }));
    expect(within(screen.getByText('DD-777-002').closest('tr')!).getByText(badge)).toBeInTheDocument();
    expect(within(screen.getByText('CC-555-001').closest('tr')!).queryByText(badge)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /Leads/ }));
    expect(within(screen.getByText('DD-777-002').closest('tr')!).getByText(badge)).toBeInTheDocument();
    expect(within(screen.getByText('HH-300-003').closest('tr')!).queryByText(badge)).not.toBeInTheDocument();

    // Support is help, not marketing: only promotions are withheld for the control group.
    await userEvent.click(screen.getByRole('tab', { name: /Support/ }));
    const supportRow = within(screen.getByText('DD-777-002').closest('tr')!);
    expect(supportRow.getByText('Control group — no promotions')).toBeInTheDocument();
    expect(supportRow.queryByText(badge)).not.toBeInTheDocument();
  });

  it('marks the control group in "expired and silent"', async () => {
    const base = snapshot();
    render(
      <KeepResults
        {...props({
          snapshot: snapshot({
            renewals: [
              ...base.renewals,
              {
                key: '111|DD-777-002',
                pid: '111',
                account: 'DD-777-002',
                expiry: D - 6 * DAY,
                renewalStyle: 'at_term',
                atRisk: true,
                kind: 'expired_silent',
                plan: 'Premium Monthly',
              },
            ],
          }),
        })}
      />
    );

    await userEvent.click(screen.getByRole('tab', { name: /Renewals/ }));
    expect(
      within(screen.getByText('DD-777-002').closest('tr')!).getByText('Control — do not contact')
    ).toBeInTheDocument();
    expect(
      within(screen.getByText('GG-200-002').closest('tr')!).queryByText('Control — do not contact')
    ).not.toBeInTheDocument();
  });

  it('finds an account in the renewals', async () => {
    render(<KeepResults {...props()} />);

    await userEvent.click(screen.getByRole('tab', { name: /Renewals/ }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Search account' }), 'ff100');
    expect(screen.getByText('FF-100-001')).toBeInTheDocument();
    expect(screen.queryByText('GG-200-002')).not.toBeInTheDocument();
    expect(screen.queryByText('2026-10-12')).not.toBeInTheDocument();
  });

  it('finds a support case and saves the support hand-off after asking', async () => {
    const onExport = jest.fn();
    const base = snapshot();
    const other = assessment('MM-500-005', {
      techIssue: true,
      recent: stats({ playbacks: 10, failedPlaybacks: 5, bufferingStops: 12, watchAllMin: 120 }),
      evidence: [{ code: 'TECH_BUFFERING', value: 6, ref: 1 }],
      platforms: ['iOS', 'AndroidTV'],
    });
    render(<KeepResults {...props({ onExport, snapshot: snapshot({ support: [...base.support, other] }) })} />);

    await userEvent.click(screen.getByRole('tab', { name: /Support/ }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Search account' }), 'mm-500');
    expect(screen.getAllByRole('row').slice(1).map(accountOf)).toEqual(['MM-500-005']);

    await userEvent.click(screen.getByRole('button', { name: /Export support CSV \(1\)/ }));
    expect(screen.getByText(/The file contains subscriber identifiers/)).toBeInTheDocument();
    expect(downloadBlob).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Save file' }));

    const [blob, name] = downloadBlob.mock.calls[0];
    expect(name).toBe('ai-insider-keep-support_2026-10-09.csv');
    const csv = await (blob as Blob).text();
    expect(csv).toContain('MM-500-005');
    expect(csv).not.toContain('EE-999-003');
    expect(csv).toContain('TECH_BUFFERING=6');
    expect(onExport).toHaveBeenCalledWith('support', 1);
  });

  it('saves the leads for sales without the control group', async () => {
    const onExport = jest.fn();
    const base = snapshot();
    const control = assessment('DD-777-002', { recent: stats({ premiumAttempts: 2 }) });
    render(<KeepResults {...props({ onExport, snapshot: snapshot({ leads: [...base.leads, control] }) })} />);

    await userEvent.click(screen.getByRole('tab', { name: /Leads/ }));
    expect(screen.getAllByRole('row')).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: /Export leads CSV \(1\)/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save file' }));

    const [blob, name] = downloadBlob.mock.calls[0];
    expect(name).toBe('ai-insider-keep-leads_2026-10-09.csv');
    const csv = await (blob as Blob).text();
    expect(csv).toContain('HH-300-003');
    expect(csv).not.toContain('DD-777-002');
    expect(onExport).toHaveBeenCalledWith('leads', 1);
  });

  it('opens a row from the keyboard', async () => {
    render(<KeepResults {...props()} />);

    const toggle = screen.getByRole('button', { name: 'Details of CC-555-001' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    toggle.focus();
    await userEvent.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Recommendations start from')).toBeInTheDocument();

    await userEvent.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Recommendations start from')).not.toBeInTheDocument();
  });

  it('names each plan override group', async () => {
    const onPlanClassChange = jest.fn();
    render(<KeepResults {...props({ onPlanClassChange })} />);

    await userEvent.click(screen.getByRole('tab', { name: /Quality/ }));
    const group = screen.getByRole('group', { name: 'Plan class of Free Trial (111)' });
    await userEvent.click(within(group).getByRole('radio', { name: 'Paid' }));
    expect(onPlanClassChange).toHaveBeenCalledWith('111', 'Free Trial', 'paid');
  });

  it('cuts a long plan list with a note and filters it by provider', async () => {
    const plans = [
      ...Array.from({ length: 200 }, (_, i) => ({
        pid: '111',
        plan: `Plan A${i}`,
        planClass: 'paid' as const,
        overridden: false,
        accounts: 1000 - i,
      })),
      ...Array.from({ length: 105 }, (_, i) => ({
        pid: '222',
        plan: `Plan B${i}`,
        planClass: 'paid' as const,
        overridden: false,
        accounts: 500 - i,
      })),
    ];
    const base = snapshot();
    render(<KeepResults {...props({ snapshot: snapshot({ quality: { ...base.quality, plans } }) })} />);

    await userEvent.click(screen.getByRole('tab', { name: /Quality/ }));
    expect(screen.getByText('Showing 300 of 305 plans. Filter by provider for the others.')).toBeInTheDocument();
    expect(screen.queryByText('Plan B104')).not.toBeInTheDocument();

    await userEvent.type(screen.getByRole('textbox', { name: 'Filter plans by provider' }), '222');
    expect(screen.getByText('Plan B104')).toBeInTheDocument();
    expect(screen.queryByText('Plan A0')).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing 300 of/)).not.toBeInTheDocument();
  }, 30000);

  it('shows the refused playbacks per platform and code, with their kind', async () => {
    render(<KeepResults {...props()} />);

    await userEvent.click(screen.getByRole('tab', { name: /Quality/ }));
    const premium = screen.getByText('402/AE402').closest('tr')!;
    expect([...premium.querySelectorAll('td')].map((td) => td.textContent)).toEqual([
      'iOS',
      '402/AE402',
      'Other package',
      '10',
    ]);
    expect(
      within(screen.getByText('subsctiprionInActive/').closest('tr')!).getByText('Not active')
    ).toBeInTheDocument();
    expect(within(screen.getByText('/103').closest('tr')!).getByText('Not in the definition')).toBeInTheDocument();
  });

  it('tells customers of providers without GA4 apart from the unmatched', () => {
    const base = snapshot();
    render(
      <KeepResults
        {...props({
          snapshot: snapshot({
            quality: {
              ...base.quality,
              behavior: { status: 'on', matched: 700, requested: 1000, notLinked: 3000 },
            },
          }),
        })}
      />
    );

    expect(
      screen.getByText('700 of 1,000 customers matched · 3,000 customers of providers without GA4')
    ).toBeInTheDocument();
  });
});
