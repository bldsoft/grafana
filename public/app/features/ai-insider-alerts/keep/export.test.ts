import { controlDocument, controlKeysOf, jobsToCsv, keepFileName, leadsToCsv, listCell, supportToCsv } from './export';
import { AccountAssessment, DEFAULT_KEEP_RULES, KeepJob, KeepSnapshot, WindowStats } from './types';

const D = Date.UTC(2026, 9, 9) / 1000;
const DAY = 86400;

function job(overrides: Partial<KeepJob> = {}): KeepJob {
  return {
    id: '1a2b3c4d',
    key: '111|AA-123-456',
    pid: '111',
    account: 'AA-123-456',
    accountKey: 'AA123456',
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
    seeds: [{ profileId: 'p1', contentType: 'tv', contentId: '20002549', title: 'Sport 1', minutes: 300 }],
    profileIds: ['p1'],
    recEndpoint: 'tvchannels',
    recFallback: false,
    techIssue: false,
    control: false,
    deferred: false,
    evidence: [
      { code: 'LAPSED', value: 4 },
      { code: 'INACTIVE_ATTEMPTS', value: 3 },
    ],
    expiry: D - 3 * DAY,
    plan: 'Premium Monthly',
    renewalStyle: 'at_term',
    consent: 'unknown',
    ...overrides,
  };
}

/** Minimal CSV reader: quoted cells with doubled quotes, no newlines inside cells. */
function parseCsv(text: string): string[][] {
  return text.split('\n').map((line) => {
    const cells: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (c === '"') {
          quoted = false;
        } else {
          cell += c;
        }
      } else if (c === '"') {
        quoted = true;
      } else if (c === ',') {
        cells.push(cell);
        cell = '';
      } else {
        cell += c;
      }
    }
    cells.push(cell);
    return cells;
  });
}

function rowsOf(csv: string): Array<Record<string, string>> {
  const [header, ...lines] = parseCsv(csv);
  return lines.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i]])));
}

describe('jobsToCsv', () => {
  it('writes the hand-off columns, ids only by default', () => {
    const csv = jobsToCsv([job()], { includeTitles: false, tzOffsetOf: () => 2 });
    const [header] = parseCsv(csv);
    expect(header).toEqual([
      'job_id',
      'provider_id',
      'account',
      'account_key',
      'profile_ids',
      'reason',
      'action',
      'offer_kind',
      'offer_step',
      'offer_tool',
      'delivery',
      'priority',
      'tier',
      'deferred',
      'send_at_utc',
      'send_local_time',
      'steps',
      'due_by_utc',
      'expiry_utc',
      'plan',
      'renewal_style',
      'rec_endpoint',
      'rec_fallback',
      'seed_content_ids',
      'evidence_codes',
      'tech_issue',
      'consent',
    ]);
    const [row] = rowsOf(csv);
    expect(row).toMatchObject({
      job_id: '1a2b3c4d',
      provider_id: '111',
      account: 'AA-123-456',
      account_key: 'AA123456',
      offer_step: '1',
      send_at_utc: '2026-10-10T08:00:00Z',
      // UTC+2: the customer's own clock.
      send_local_time: '10:00',
      steps: '2026-10-10T08:00:00Z crm payment_link',
      due_by_utc: '',
      expiry_utc: '2026-10-06T00:00:00Z',
      seed_content_ids: 'tv:20002549',
      evidence_codes: 'LAPSED=4|INACTIVE_ATTEMPTS=3',
      consent: 'unknown',
    });
    expect(csv).not.toContain('Sport 1');
  });

  it('adds the seed titles only when asked', () => {
    const csv = jobsToCsv([job()], { includeTitles: true });
    const [header] = parseCsv(csv);
    expect(header.slice(header.indexOf('seed_content_ids'), header.indexOf('evidence_codes') + 1)).toEqual([
      'seed_content_ids',
      'seed_titles',
      'evidence_codes',
    ]);
    expect(rowsOf(csv)[0].seed_titles).toBe('Sport 1');
    expect(rowsOf(csv)[0].send_local_time).toBe('');
  });

  it('never exports the control group or support hand-offs', () => {
    const csv = jobsToCsv(
      [
        job({ id: 'treat' }),
        job({ id: 'held', control: true }),
        job({ id: 'tech', action: 'support', reason: 'technical', techIssue: true }),
      ],
      { includeTitles: false }
    );
    expect(rowsOf(csv).map((r) => r.job_id)).toEqual(['treat']);
  });

  it('keeps formulas planted in plan names and titles as text', () => {
    const csv = jobsToCsv(
      [
        job({
          plan: '=HYPERLINK("http://x","y")',
          seeds: [{ profileId: 'p1', contentType: 'vod', contentId: '7', title: '@SUM(A1)', minutes: 50 }],
        }),
      ],
      { includeTitles: true }
    );
    const [row] = rowsOf(csv);
    expect(row.plan).toBe(`'=HYPERLINK("http://x","y")`);
    expect(row.seed_titles).toBe(`'@SUM(A1)`);
  });

  it('guards every element of a list cell, not only the first one', () => {
    const csv = jobsToCsv(
      [
        job({
          profileIds: ['p1', '=cmd'],
          seeds: [
            { profileId: 'p1', contentType: 'tv', contentId: '1', title: 'Sport 1', minutes: 50 },
            { profileId: 'p1', contentType: 'vod', contentId: '+2', title: '=1+1', minutes: 40 },
            { profileId: 'p1', contentType: 'vod', contentId: '3', title: 'Love; Death | Robots', minutes: 30 },
          ],
        }),
      ],
      { includeTitles: true }
    );
    const [row] = rowsOf(csv);
    expect(row.profile_ids).toBe(`p1|'=cmd`);
    expect(row.seed_content_ids).toBe(`tv:1|vod:+2|vod:3`);
    // One title per id: a ';' or '|' inside a title does not shift them.
    expect(row.seed_titles).toBe(`Sport 1|'=1+1|Love; Death \\| Robots`);
    // A cell with a ';' is quoted for CSV readers; nothing after the ';' starts a formula.
    expect(csv).toContain(`,"Sport 1|'=1+1|Love; Death \\| Robots",`);
  });

  it('neutralizes a formula after a semicolon (spreadsheets splitting on ";" start a cell there)', () => {
    const csv = jobsToCsv([job({ plan: 'Basic;=1+1;' })], { includeTitles: false });
    expect(csv).toContain(`,"Basic;'=1+1;",`);
    // Whatever a ';'-splitting spreadsheet makes of the line, no piece starts a formula.
    for (const line of csv.split('\n')) {
      for (const piece of line.split(';').slice(1)) {
        expect(piece).not.toMatch(/^"*[=+\-@]/);
      }
    }
  });

  it('gives the steps of a deferred job no send times either', () => {
    const steps = [
      { at: Date.UTC(2026, 9, 11, 17) / 1000, channel: 'push' as const, what: 'reminder' as const },
      { at: Date.UTC(2026, 9, 15, 17) / 1000, channel: 'push' as const, what: 'payment_link' as const },
    ];
    const csv = jobsToCsv([job({ id: 'later', action: 'renewal_campaign', deferred: true, steps })], {
      includeTitles: false,
    });
    expect(rowsOf(csv)[0].steps).toBe('push reminder|push payment_link');
  });

  it('leaves the send time of a deferred job empty', () => {
    const csv = jobsToCsv([job({ id: 'now' }), job({ id: 'later', deferred: true })], {
      includeTitles: false,
      tzOffsetOf: () => 2,
    });
    const [now, later] = rowsOf(csv);
    expect(now).toMatchObject({ deferred: 'false', send_at_utc: '2026-10-10T08:00:00Z', send_local_time: '10:00' });
    expect(later).toMatchObject({ deferred: 'true', send_at_utc: '', send_local_time: '' });
  });
});

describe('listCell', () => {
  it('joins with | and escapes | and \\ inside the values', () => {
    expect(listCell(['a', 'b|c', 'd\\e'])).toBe('a|b\\|c|d\\\\e');
    expect(listCell([])).toBe('');
  });

  it('guards each formula-like element', () => {
    expect(listCell(['ok', '-1', '@x', '+y', '=z'])).toBe(`ok|'-1|'@x|'+y|'=z`);
  });
});

function stats(overrides: Partial<WindowStats> = {}): WindowStats {
  return {
    activeDays: 5,
    events: 300,
    legacyEvents: 0,
    gatedPlays: 20,
    ungatedPlays: 0,
    watchAllMin: 70,
    watchMin: 60,
    liveMin: 60,
    ondemandMin: 10,
    catchupMin: 0,
    distinctPerDay: 3,
    playbacks: 20,
    failedPlaybacks: 0,
    failedDays: 0,
    bufferingStops: 0,
    inactiveAttempts: 0,
    premiumAttempts: 0,
    premiumPaidContent: 0,
    searchSessions: 0,
    failedSearchSessions: 0,
    favAdded: 0,
    favRemoved: 0,
    appStarts: 10,
    ...overrides,
  };
}

function account(name: string, overrides: Partial<AccountAssessment> = {}): AccountAssessment {
  return {
    key: `111|${name}`,
    pid: '111',
    account: name,
    accountKey: name.replace(/-/g, ''),
    eligible: true,
    atRisk: false,
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
    lastSeen: D,
    daysSinceLastSeen: 0,
    recent: stats(),
    baseline: stats({ watchAllMin: 420 }),
    fadeRatio: null,
    dailyWatch: [],
    platforms: ['iOS'],
    signalCoverage: 'full',
    evidence: [],
    techIssue: false,
    topErrCode: '',
    seeds: [],
    peakHour: null,
    tzOffsetH: null,
    ...overrides,
  };
}

describe('supportToCsv', () => {
  it('writes the support hand-off, the control group marked', () => {
    const tech = account('AA-1', {
      techIssue: true,
      topErrCode: '403/1001',
      // 30 failed out of 20 playbacks (other attempts): the share stays at most 1.
      recent: stats({ playbacks: 20, failedPlaybacks: 30, bufferingStops: 14, watchAllMin: 120 }),
      evidence: [
        { code: 'TECH_ERRORS', value: 1, label: '403/1001' },
        { code: 'TECH_BUFFERING', value: 7, ref: 1 },
      ],
      platforms: ['iOS', '=AndroidTV'],
    });
    const deact = account('BB-2', {
      deactivatedAt: D - 2 * DAY,
      deactivated: true,
      recent: stats({ playbacks: 0, watchAllMin: 0 }),
      evidence: [{ code: 'DEACTIVATED', value: D - 2 * DAY }],
    });
    const old = account('CC-3', { deactivatedAt: D - 35 * DAY, deactivated: false, techIssue: true });
    const csv = supportToCsv([tech, deact, old], {
      rules: DEFAULT_KEEP_RULES,
      controlKeys: controlKeysOf([job({ key: '111|BB-2', control: true })]),
    });

    expect(parseCsv(csv)[0]).toEqual([
      'provider_id',
      'account',
      'account_key',
      'plan',
      'reason_codes',
      'top_err_code',
      'failed_playbacks',
      'playbacks',
      'failed_share',
      'buffering_per_hour',
      'watched_min_per_day',
      'deactivated',
      'deactivated_at_utc',
      'tech_issue',
      'control',
      'platforms',
    ]);
    const [a, b, c] = rowsOf(csv);
    expect(a).toMatchObject({
      provider_id: '111',
      account: 'AA-1',
      account_key: 'AA1',
      reason_codes: 'TECH_ERRORS=1|TECH_BUFFERING=7',
      top_err_code: '403/1001',
      failed_share: '1',
      buffering_per_hour: '7',
      watched_min_per_day: '17.1',
      deactivated: 'false',
      deactivated_at_utc: '',
      control: 'false',
      platforms: `iOS|'=AndroidTV`,
    });
    expect(b).toMatchObject({
      failed_share: '',
      buffering_per_hour: '',
      deactivated: 'true',
      deactivated_at_utc: '2026-10-07T00:00:00Z',
      control: 'true',
    });
    // A deactivation older than the lookback is not one.
    expect(c).toMatchObject({ deactivated: 'false', deactivated_at_utc: '' });
  });
});

describe('leadsToCsv', () => {
  const lead = account('HH-3', {
    recent: stats({ premiumAttempts: 5, premiumPaidContent: 1 }),
    evidence: [{ code: 'PREMIUM_ATTEMPTS', value: 4, label: 'Champions League' }],
  });
  const held = account('DD-7', { recent: stats({ premiumAttempts: 2 }) });
  const controlKeys = controlKeysOf([job({ key: '111|DD-7', control: true })]);

  it('drops the control group and adds titles only when asked', () => {
    const csv = leadsToCsv([lead, held], { rules: DEFAULT_KEEP_RULES, controlKeys, includeTitles: false });
    const rows = rowsOf(csv);
    expect(rows.map((r) => r.account)).toEqual(['HH-3']);
    expect(rows[0]).toMatchObject({
      refused_other_package: '4',
      watched_min_per_day: '10',
      watched_min_per_day_before: '20',
      evidence_codes: 'PREMIUM_ATTEMPTS=4',
      expiry_utc: '2026-10-29T00:00:00Z',
    });
    expect(csv).not.toContain('Champions League');

    const titled = rowsOf(leadsToCsv([lead], { rules: DEFAULT_KEEP_RULES, controlKeys, includeTitles: true }));
    expect(titled[0].refused_title).toBe('Champions League');
  });
});

describe('controlDocument', () => {
  it('lists only the control group, with the salt that drew it', () => {
    const snapshot = {
      asOf: D,
      pids: ['111'],
      jobs: [job({ id: 'treat' }), job({ id: 'held', control: true, account: 'BB-1', accountKey: 'BB1' })],
    } as KeepSnapshot;
    const doc = controlDocument(snapshot, DEFAULT_KEEP_RULES);
    expect(doc).toMatchObject({
      format: 'ai-insider-keep-control',
      asOf: '2026-10-09',
      pids: ['111'],
      holdoutShare: 0.2,
      holdoutSalt: '2026Q4',
    });
    expect(doc.jobs).toEqual([
      expect.objectContaining({ id: 'held', account: 'BB-1', evidence: 'LAPSED=4|INACTIVE_ATTEMPTS=3' }),
    ]);
  });
});

describe('keepFileName', () => {
  it('names the files after the as-of day', () => {
    expect(keepFileName('jobs', D + 3600, 'csv')).toBe('ai-insider-keep-jobs_2026-10-09.csv');
    expect(keepFileName('control', D, 'json')).toBe('ai-insider-keep-control_2026-10-09.json');
    expect(keepFileName('support', D, 'csv')).toBe('ai-insider-keep-support_2026-10-09.csv');
  });
});
