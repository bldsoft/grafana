import { blockFromRows } from './blocks';
import {
  KeepEngine,
  accountKeyOf,
  fnv1a32,
  graceDays,
  hash64Hex,
  parseDeliveryByPid,
  planClassOf,
  ruleDays,
} from './engine';
import {
  AccountDayRow,
  BehaviorRow,
  DayBlock,
  DEFAULT_KEEP_RULES,
  KeepEngineOptions,
  KeepRules,
  KeepSnapshot,
} from './types';

const DAY = 86400;
const HOUR = 3600;
/** As-of day: Monday 2026-10-05 (ISO week 41). Recent = k -6..0, baseline = k -27..-7, history = k -39..0. */
const T0 = Date.UTC(2026, 9, 5) / 1000;
const D_END = T0 + DAY;
/** A subscription end far away: no renewal signal. */
const FAR = T0 + 60 * DAY + 13 * HOUR;
const at = (k: number, hour = 0) => T0 + k * DAY + hour * HOUR;
const ends = (pairs: Array<[number, number]>) =>
  JSON.stringify([pairs.map(([end]) => end), pairs.map(([, seen]) => seen)]);

/** A full account-day of an ordinary paying viewer: an hour of live TV a day, one title. */
function row(day: number, account: string, overrides: Partial<AccountDayRow> = {}): Partial<AccountDayRow> {
  return {
    pid: '111',
    account,
    events: 40,
    legacy_events: 0,
    gated_plays: 4,
    ungated_plays: 0,
    watch_all_min: 60,
    expiry_seen: ends([[FAR, day + HOUR]]),
    expired_events: 0,
    inactive_attempts: 0,
    plan: 'Premium Monthly',
    first_ts: day + HOUR,
    last_ts: day + 20 * HOUR,
    platforms: 'Android',
    app_starts: 2,
    watch_min: 55,
    live_min: 60,
    ondemand_min: 0,
    catchup_min: 0,
    distinct_content: 3,
    seeds: JSON.stringify([[['p1', 'tv', '100', 'News 24'], 3600, 0]]),
    playbacks: 4,
    failed_playbacks: 0,
    buffering_stops: 0,
    top_err_code: '',
    premium_attempts: 0,
    premium_paid_content: 0,
    paywall_title: '',
    search_sessions: 0,
    failed_search_sessions: 0,
    fav_added: 0,
    fav_removed: 0,
    org: 'TV Plus',
    sub_id: '100200300',
    org_id: '1',
    hours: JSON.stringify([
      [20, 3000],
      [21, 600],
    ]),
    tz_offset_h: 2,
    ...overrides,
  };
}

/** Per account: the overrides of day k (relative to T0), or null when the account was not active. */
type Gen = (k: number, day: number) => Partial<AccountDayRow> | null;

interface Feed {
  rules?: Partial<KeepRules>;
  options?: KeepEngineOptions;
  from?: number;
  to?: number;
  /** Days from here on are read at the full level (older ones: light). */
  fullFrom?: number;
}

function feed(engine: KeepEngine, gens: Record<string, Gen>, f: Feed = {}) {
  const from = f.from ?? -39;
  const to = f.to ?? 0;
  const fullFrom = f.fullFrom ?? -27;
  for (let k = from; k <= to; k++) {
    const day = at(k);
    const rows: Array<Partial<AccountDayRow>> = [];
    for (const [account, gen] of Object.entries(gens)) {
      const o = gen(k, day);
      if (o) {
        rows.push(row(day, account, o));
      }
    }
    engine.ingestDay(blockFromRows(day, k >= fullFrom ? 'full' : 'light', rows));
  }
  return engine;
}

function engineOf(gens: Record<string, Gen>, f: Feed = {}) {
  return feed(new KeepEngine({ ...DEFAULT_KEEP_RULES, holdoutShare: 0, ...f.rules }, f.options), gens, f);
}

const daily: Gen = () => ({});
/** Active up to day k = last, then silent. */
const until =
  (last: number, overrides: Partial<AccountDayRow> = {}): Gen =>
  (k) =>
    k <= last ? overrides : null;
/** Baseline as usual, recent watch time `recentMin` per day (fading when low). */
const watching =
  (recentMin: number, recent: Partial<AccountDayRow> = {}): Gen =>
  (k) =>
    k >= -6 ? { watch_all_min: recentMin, live_min: recentMin, ...recent } : {};

const assessment = (snap: KeepSnapshot, account: string) => snap.assessments.find((a) => a.account === account);
const jobOf = (snap: KeepSnapshot, account: string) => snap.jobs.find((j) => j.account === account);
const codes = (list: Array<{ code: string }> | undefined) => (list ?? []).map((e) => e.code);

function behavior(account: string, overrides: Partial<BehaviorRow> = {}): BehaviorRow {
  return {
    pid: '111',
    account,
    days: 7,
    sessions: 10,
    engagementMin: 120,
    searchSessions: 0,
    searchNoPlaySessions: 0,
    browseNoPlaySessions: 0,
    crashes: 0,
    crashDays: 0,
    errorScreenSessions: 0,
    noInternetSessions: 0,
    accountVisits: 0,
    logoutClicks: 0,
    myListAdds: 0,
    myListRemoves: 0,
    platforms: ['Android'],
    ...overrides,
  };
}

describe('helpers', () => {
  it('parses delivery per provider and ignores unknown words', () => {
    expect(parseDeliveryByPid('111=crm, 222=push; 333: none\n444=sms, bad pid=push, 555=PUSH')).toEqual({
      '111': 'crm',
      '222': 'push',
      '333': 'none',
      '555': 'push',
    });
    expect(parseDeliveryByPid('')).toEqual({});
  });

  it('normalizes the account key shared with GA4', () => {
    expect(accountKeyOf(' aa-111-111_42 ')).toBe('AA111111');
    expect(accountKeyOf('XYZ-12')).toBe('XYZ12');
  });

  it('classifies plans by name, with overrides per provider and plan', () => {
    expect(planClassOf('Free', '111')).toBe('free');
    expect(planClassOf('7-day trial', '111')).toBe('free');
    expect(planClassOf('Ad-Free Premium', '111')).toBe('paid');
    expect(planClassOf('Freedom Pack', '111')).toBe('paid');
    expect(planClassOf('', '111')).toBe('unknown');
    expect(planClassOf('Freedom Pack', '111', { '111|Freedom Pack': 'free' })).toBe('free');
    expect(planClassOf('Freedom Pack', '222', { '111|Freedom Pack': 'free' })).toBe('paid');
  });

  it('hashes with 32-bit FNV-1a over UTF-8', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
    const utf8 = (text: string) => {
      let h = 0x811c9dc5;
      for (const byte of Buffer.from(text, 'utf8')) {
        h = Math.imul(h ^ byte, 0x01000193);
      }
      return h >>> 0;
    };
    expect(fnv1a32('Shqipëri 📺')).toBe(utf8('Shqipëri 📺'));
  });

  it('builds 64-bit ids from two FNV-1a passes with different offset bases', () => {
    const id = hash64Hex('111|A|re_engagement|||2026-W41');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id.slice(0, 8)).toBe(fnv1a32('111|A|re_engagement|||2026-W41').toString(16).padStart(8, '0'));
    expect(id.slice(8)).not.toBe(id.slice(0, 8));
    expect(hash64Hex('111|A|re_engagement|||2026-W41')).toBe(id);
  });

  it('turns rule day counts into whole days the same way as the runner', () => {
    expect([ruleDays(7.9), ruleDays(0), ruleDays(Number.NaN)]).toEqual([7, 1, 1]);
    expect([graceDays(2.5), graceDays(0), graceDays(-3), graceDays(Number.NaN)]).toEqual([2, 0, 0, 0]);
  });
});

describe('KeepEngine days', () => {
  it('holds days by level: a full day covers a light need, a half day covers nothing', () => {
    const engine = new KeepEngine(DEFAULT_KEEP_RULES);
    engine.ingestDay(blockFromRows(at(-1), 'full', [row(at(-1), 'A')]));
    engine.ingestDay(blockFromRows(at(-30), 'light', [row(at(-30), 'A')]));
    expect(engine.hasDay(at(-1), 'light')).toBe(true);
    expect(engine.hasDay(at(-1), 'full')).toBe(true);
    expect(engine.hasDay(at(-30), 'full')).toBe(false);

    engine.ingestDay(blockFromRows(at(0), 'full', [row(at(0), 'A')], at(0), at(0, 12)));
    expect(engine.hasDay(at(0), 'full')).toBe(false);
    engine.ingestDay(blockFromRows(at(0), 'full', [row(at(0), 'A')], at(0, 12), at(1)));
    expect(engine.hasDay(at(0), 'full')).toBe(true);
    expect(engine.days()).toEqual([
      { day: at(-30), level: 'light', rows: 1 },
      { day: at(-1), level: 'full', rows: 1 },
      { day: at(0), level: 'full', rows: 1 },
    ]);

    engine.evictOutside(at(-1), at(0));
    expect(engine.days().map((d) => d.day)).toEqual([at(-1), at(0)]);
  });

  it('applies other rules and options to the days it holds, without reading them again', () => {
    const engine = engineOf({ A: until(-4) });
    expect(engine.evaluate(T0).jobs).toEqual([]);
    const stricter = engine.withSettings(
      { ...engine.rules, quietDays: 3 },
      { deliveryByPid: { '111': 'crm' }, planClassOverrides: {} }
    );
    expect(stricter.days()).toEqual(engine.days());
    expect(stricter.rules.quietDays).toBe(3);
    expect(jobOf(stricter.evaluate(T0), 'A')).toMatchObject({ action: 're_engagement', delivery: 'crm' });
    // The first engine keeps its own rules.
    expect(engine.evaluate(T0).jobs).toEqual([]);
  });

  it('adds the two halves of a day without counting the day twice', () => {
    const engine = engineOf({ A: daily }, { to: -2 });
    const half = (from: number, to: number) =>
      blockFromRows(at(-1), 'full', [row(at(-1), 'A', { watch_all_min: 30, failed_playbacks: 1 })], from, to);
    engine.ingestDay(half(at(-1), at(-1, 12)));
    // The same half read again replaces itself.
    engine.ingestDay(half(at(-1), at(-1, 12)));
    engine.ingestDay(half(at(-1, 12), at(0)));
    feed(engine, { A: daily }, { from: 0, to: 0 });

    const a = assessment(engine.evaluate(T0), 'A');
    expect(a?.recent.activeDays).toBe(7);
    expect(a?.recent.watchAllMin).toBe(6 * 60 + 60);
    expect(a?.recent.failedPlaybacks).toBe(2);
    expect(a?.recent.failedDays).toBe(1);
  });

  it('counts a block that repeats an account once', () => {
    const engine = engineOf({ A: daily }, { to: -1 });
    engine.ingestDay(blockFromRows(at(0), 'full', [row(at(0), 'A'), row(at(0), 'A', { watch_all_min: 10 })]));
    const a = assessment(engine.evaluate(T0), 'A');
    expect(a?.recent.activeDays).toBe(7);
    expect(a?.recent.watchAllMin).toBe(6 * 60 + 70);
  });

  it('replaces a light day with the full read of the whole day, never adding the two', () => {
    const engine = engineOf({ A: daily }, { to: -2 });
    engine.ingestDay(blockFromRows(at(-1), 'light', [row(at(-1), 'A', { events: 40, watch_all_min: 60 })]));
    expect(engine.hasDay(at(-1), 'full')).toBe(false);
    engine.ingestDay(blockFromRows(at(-1), 'full', [row(at(-1), 'A', { events: 40, watch_all_min: 60 })]));
    feed(engine, { A: daily }, { from: 0, to: 0 });

    expect(engine.days().filter((d) => d.day === at(-1))).toEqual([{ day: at(-1), level: 'full', rows: 1 }]);
    const a = assessment(engine.evaluate(T0), 'A');
    expect(a?.recent).toMatchObject({ activeDays: 7, events: 7 * 40, watchAllMin: 7 * 60, playbacks: 7 * 4 });
  });

  it('replaces a light day with a full read in two halves: full only once both halves are in', () => {
    const engine = engineOf({ A: daily }, { to: -2 });
    engine.ingestDay(blockFromRows(at(-1), 'light', [row(at(-1), 'A')]));
    const half = (from: number, to: number) =>
      blockFromRows(at(-1), 'full', [row(at(-1), 'A', { events: 20, watch_all_min: 30, playbacks: 2 })], from, to);
    engine.ingestDay(half(at(-1), at(-1, 12)));
    // The first half overlaps the held light day: it replaces it (half a day held, at no level).
    expect(engine.hasDay(at(-1), 'light')).toBe(false);
    expect(engine.hasDay(at(-1), 'full')).toBe(false);
    engine.ingestDay(half(at(-1, 12), at(0)));
    expect(engine.hasDay(at(-1), 'full')).toBe(true);
    feed(engine, { A: daily }, { from: 0, to: 0 });

    expect(engine.days().filter((d) => d.day === at(-1))).toEqual([{ day: at(-1), level: 'full', rows: 1 }]);
    const a = assessment(engine.evaluate(T0), 'A');
    expect(a?.recent).toMatchObject({ activeDays: 7, events: 7 * 40, watchAllMin: 7 * 60, playbacks: 7 * 4 });
  });

  it('forgets the accounts of evicted days once they are the majority, and still evaluates the rest', () => {
    const gens: Record<string, Gen> = { KEEP: daily };
    for (let i = 0; i < 6; i++) {
      // Accounts seen only on the oldest days.
      gens[`OLD-${i}`] = (k) => (k <= -35 ? {} : null);
    }
    const engine = engineOf(gens);
    expect(engine.accountCount()).toBe(7);
    const before = assessment(engine.evaluate(T0), 'KEEP');
    engine.evictOutside(at(-30), at(0));
    expect(engine.accountCount()).toBe(1);
    // New accounts after the compaction get fresh ids; nothing is mixed up.
    feed(engine, { KEEP: daily, NEW: daily }, { from: -1, to: 0 });
    const snap = engine.evaluate(T0);
    expect(assessment(snap, 'KEEP')).toMatchObject({ recent: before?.recent, baseline: before?.baseline });
    expect(snap.assessments.map((x) => x.account).sort()).toEqual(['KEEP', 'NEW']);
    expect(engine.accountCount()).toBe(2);
  });

  it('never reads full columns from a light day, and names the day as missing', () => {
    const engine = engineOf({ A: daily }, { to: -2 });
    engine.ingestDay(
      blockFromRows(at(-1), 'light', [row(at(-1), 'A', { playbacks: 100, failed_playbacks: 90, distinct_content: 50 })])
    );
    feed(engine, { A: daily }, { from: 0, to: 0 });
    const snap = engine.evaluate(T0);
    const a = assessment(snap, 'A');
    expect(a?.recent.activeDays).toBe(7);
    expect(a?.recent.playbacks).toBe(24);
    expect(a?.recent.distinctPerDay).toBe(3);
    expect(a?.techIssue).toBe(false);
    expect(snap.quality.missingDays).toEqual([at(-1)]);
  });

  it('skips malformed JSON cells and reads numbers that arrive as strings', () => {
    const engine = engineOf({
      A: (k) =>
        k === 0
          ? {
              expiry_seen: '[[1790000000',
              seeds: '{"item":',
              hours: 'null',
              tz_offset_h: Number.NaN,
              events: '40' as unknown as number,
            }
          : { watch_all_min: '60' as unknown as number },
    });
    const a = assessment(engine.evaluate(T0), 'A');
    expect(a?.recent.watchAllMin).toBe(6 * 60 + 60);
    expect(a?.recent.events).toBe(7 * 40);
    // The last good day still names the end.
    expect(a?.expiry).toBe(FAR);
  });

  it('accepts tuples as arrays or objects, 64-bit numbers as strings, and a map of ends', () => {
    const end = T0 + 40 * DAY;
    const engine = engineOf({
      A: (k, day) => ({
        expiry_seen:
          k % 2 ? JSON.stringify({ 1: [String(end)], 2: [String(day + HOUR)] }) : JSON.stringify({ [end]: day + HOUR }),
        seeds: JSON.stringify([{ item: { 1: 'p7', 2: 'vod', 3: '55', 4: 'Film' }, count: '1800', error: '0' }]),
        hours: JSON.stringify([{ 1: 21, 2: '1200' }]),
      }),
      B: watching(0, { expiry_seen: '{}' }),
    });
    const snap = engine.evaluate(T0);
    const a = assessment(snap, 'A');
    expect(a?.expiry).toBe(end);
    expect(a?.renewalStyle).toBe('unknown');
    // B fades, so its details (seeds, hours) are read.
    const b = assessment(snap, 'B');
    expect(b?.atRisk).toBe(true);
    expect(b?.seeds[0]).toMatchObject({ profileId: 'p1', contentType: 'tv', contentId: '100', title: 'News 24' });
    const engine2 = engineOf({
      C: watching(0, {
        seeds: JSON.stringify([{ item: { 1: 'p7', 2: 'vod', 3: '55', 4: 'Film' }, count: '1800', error: '0' }]),
        hours: JSON.stringify([{ 1: 21, 2: '1200' }]),
      }),
    });
    const c = assessment(engine2.evaluate(T0), 'C');
    expect(c?.seeds.find((s) => s.contentId === '55')).toEqual({
      profileId: 'p7',
      contentType: 'vod',
      contentId: '55',
      title: 'Film',
      minutes: 210,
    });
  });
});

describe('KeepEngine eligibility', () => {
  it('keeps customers with enough baseline days on a plan that is not free', () => {
    const engine = engineOf({
      PAYING: daily,
      NEW: (k) => (k >= -9 ? {} : null),
      FREE: (k) => ({ plan: k < -6 ? 'Free' : 'Premium' }),
      UNKNOWN: (k) => ({ plan: '' }),
    });
    const snap = engine.evaluate(T0);
    expect(assessment(snap, 'PAYING')).toMatchObject({ eligible: true, planClass: 'paid' });
    expect(assessment(snap, 'NEW')).toMatchObject({ eligible: false, ineligibleReason: 'new' });
    // The baseline plan decides (an upgrade in the recent window does not make the customer one to keep).
    expect(assessment(snap, 'FREE')).toMatchObject({ eligible: false, ineligibleReason: 'free', baselinePlan: 'Free' });
    expect(assessment(snap, 'UNKNOWN')).toMatchObject({ eligible: true, planClass: 'unknown' });

    const withFree = engineOf({ FREE: (k) => ({ plan: 'Free' }) }, { rules: { includeFreePlans: true } });
    expect(assessment(withFree.evaluate(T0), 'FREE')?.eligible).toBe(true);
  });
});

describe('KeepEngine signals', () => {
  it('QUIET: a daily viewer silent for 5 days, but not a viewer who comes every 4 days', () => {
    const snap = engineOf({
      DAILY: until(-5),
      EVERY4: (k) => ((k <= -7 && (k + 27) % 4 === 0) || k === -5 ? {} : null),
    }).evaluate(T0);
    const dailyViewer = assessment(snap, 'DAILY');
    expect(dailyViewer?.daysSinceLastSeen).toBe(5);
    expect(codes(dailyViewer?.evidence)).toContain('QUIET');
    expect(dailyViewer?.evidence.find((e) => e.code === 'QUIET')).toEqual({ code: 'QUIET', value: 5, ref: 5 });
    const every4 = assessment(snap, 'EVERY4');
    expect(every4?.daysSinceLastSeen).toBe(5);
    expect(every4?.eligible).toBe(true);
    // Longest baseline gap 4 days × 1.5 → quiet only from 6 days.
    expect(codes(every4?.evidence)).not.toContain('QUIET');
  });

  it('FADING is judged against the provider median ratio', () => {
    const snap = engineOf({
      A: watching(30),
      B: watching(30),
      C: watching(30),
      DROP: watching(6),
    }).evaluate(T0);
    // Median ratio 0.5: half the usual is the provider's trend, a tenth is fading.
    expect(assessment(snap, 'A')).toMatchObject({ fadeRatio: 1, atRisk: false });
    expect(assessment(snap, 'DROP')).toMatchObject({ fadeRatio: 0.2, atRisk: true });
    expect(assessment(snap, 'DROP')?.evidence[0]).toEqual({ code: 'FADING', value: 0.2, ref: 60 });
  });

  it('FADING clamps the provider median, so a provider-wide drop still shows', () => {
    const snap = engineOf({ A: watching(12), B: watching(12), C: watching(12) }).evaluate(T0);
    expect(assessment(snap, 'A')).toMatchObject({ fadeRatio: 0.4, atRisk: true });
  });

  it('FADING is not judged for light viewers', () => {
    const snap = engineOf({ LIGHT: (k) => ({ watch_all_min: k >= -6 ? 0 : 10 }) }).evaluate(T0);
    expect(assessment(snap, 'LIGHT')).toMatchObject({ fadeRatio: null, atRisk: false });
  });

  it('FADING after a move to set-top boxes also needs fewer plays', () => {
    const moved = engineOf({ A: watching(6, { gated_plays: 1, ungated_plays: 6 }) }).evaluate(T0);
    expect(assessment(moved, 'A')).toMatchObject({ fadeRatio: 0.2, atRisk: false });

    const gone = engineOf({ A: watching(6, { gated_plays: 0, ungated_plays: 1 }) }).evaluate(T0);
    const a = assessment(gone, 'A');
    expect(a?.atRisk).toBe(true);
    expect(a?.evidence.filter((e) => e.code.startsWith('FADING'))).toEqual([
      { code: 'FADING', value: 0.2, ref: 60 },
      { code: 'FADING_PLAYS', value: 0.25 },
    ]);
  });

  it('FADING of legacy-only accounts (no watch time) uses active days', () => {
    const legacy: Partial<AccountDayRow> = {
      events: 30,
      legacy_events: 30,
      gated_plays: 0,
      ungated_plays: 5,
      watch_all_min: 0,
      live_min: 0,
      watch_min: 0,
      expiry_seen: '',
      plan: '',
      seeds: '',
      hours: '',
      distinct_content: 0,
      tz_offset_h: -99,
      platforms: 'STB',
    };
    const snap = engineOf({ STB: (k) => (k >= -6 && k < 0 ? null : legacy) }).evaluate(T0);
    const a = assessment(snap, 'STB');
    expect(a).toMatchObject({
      eligible: true,
      planClass: 'unknown',
      signalCoverage: 'legacy_only',
      expiry: null,
      noEnd: false,
      fadeRatio: 0.143,
      atRisk: true,
    });
    expect(a?.evidence[0]).toEqual({ code: 'FADING_PLAYS', value: 0.143, ref: 1 });
    expect(snap.quality).toMatchObject({ legacyOnly: 1, planUnknown: 1, expiryUnknown: 1 });
    // No time zone: the job can go at any time.
    expect(jobOf(snap, 'STB')).toMatchObject({ action: 're_engagement', sendAt: null });
  });
});

describe('KeepEngine renewal style', () => {
  /** E1 ends at k -20 13:00; E2 = E1 + 30 d, first seen at `renewedAt`. */
  const E1 = at(-20, 13);
  function renewal(e2: number, renewedAt: number, extra: Gen = () => ({})): Gen {
    return (k, day) => {
      const base = extra(k, day);
      if (base === null) {
        return null;
      }
      const pairs: Array<[number, number]> = [];
      if (day + HOUR < renewedAt) {
        pairs.push([E1, day + HOUR]);
      }
      if (renewedAt < day + DAY) {
        pairs.push([e2, Math.max(day + HOUR, renewedAt)]);
      }
      return { expiry_seen: ends(pairs), ...base };
    };
  }

  it('at term: the new end keeps the time of day and appears around the old end', () => {
    const E2 = E1 + 30 * DAY;
    const snap = engineOf({ A: renewal(E2, at(-20, 14)) }).evaluate(T0);
    expect(assessment(snap, 'A')).toMatchObject({ renewalStyle: 'at_term', expiry: E2, atRisk: false });
    // Renews without a job: the Renewals list asks to check the automatic payment.
    expect(snap.renewals).toEqual([
      expect.objectContaining({ account: 'A', kind: 'check_autopay', renewalStyle: 'at_term', expiry: E2 }),
    ]);
    expect(snap.jobs).toEqual([]);
  });

  it('early: the new end appeared more than 36 h before the old one', () => {
    const E2 = E1 + 30 * DAY;
    const snap = engineOf({ A: renewal(E2, at(-25, 10)) }).evaluate(T0);
    expect(assessment(snap, 'A')?.renewalStyle).toBe('early');
    expect(snap.renewals[0]?.kind).toBe('check_autopay');
  });

  it('repurchase: the end ran out, the customer was around, then bought a new term', () => {
    const E3 = at(-18, 9.5) + 23 * DAY;
    const snap = engineOf({
      A: renewal(E3, at(-18, 9.5), (k) =>
        k === -19 ? { expired_events: 5, expired_reports: ends([[E1, at(-19, 8)]]) } : {}
      ),
    }).evaluate(T0);
    const a = assessment(snap, 'A');
    expect(a).toMatchObject({ renewalStyle: 'repurchase', expiry: E3, atRisk: true });
    expect(codes(a?.evidence)).toEqual(expect.arrayContaining(['EXPIRING', 'RENEWAL_REPURCHASE']));
    const job = jobOf(snap, 'A');
    expect(job).toMatchObject({
      reason: 'timing',
      action: 'renewal_campaign',
      offerTool: 'payment_link',
      dueBy: E3,
      delivery: 'unset',
      id: hash64Hex(`111|A|renewal_campaign|||${E3}`),
    });
    expect(job?.steps).toEqual([
      { at: E3 - 3 * DAY, channel: 'unset', what: 'reminder' },
      { at: E3 - DAY, channel: 'unset', what: 'reminder' },
      { at: E3 + DAY, channel: 'unset', what: 'payment_link' },
    ]);
    expect(job?.sendAt).toBe(E3 - 3 * DAY);
    expect(job?.evidence[0].code).toBe('EXPIRING');
    expect(snap.renewals[0]).toMatchObject({ kind: 'at_risk', renewalStyle: 'repurchase' });
  });

  it('repurchase also when the time of day is kept but the old end was reported as passed before the new one', () => {
    const E2 = E1 + 30 * DAY;
    // The report arrives as a map end → first report (the other JSON shape).
    const snap = engineOf({
      A: renewal(E2, at(-18, 10), (k) =>
        k === -19 ? { expired_events: 3, expired_reports: JSON.stringify({ [E1]: at(-19, 9) }) } : {}
      ),
    }).evaluate(T0);
    expect(assessment(snap, 'A')?.renewalStyle).toBe('repurchase');
  });

  it('at term when the old end is reported as passed only after the new end appeared that day', () => {
    const E2 = E1 + 30 * DAY;
    // A second device refreshes late: it still sends the old end at 15:00, after E2 was seen at 14:00.
    const late = engineOf({
      A: renewal(E2, at(-20, 14), (k) =>
        k === -20 ? { expired_events: 1, expired_reports: ends([[E1, at(-20, 15)]]) } : {}
      ),
    }).evaluate(T0);
    expect(assessment(late, 'A')).toMatchObject({ renewalStyle: 'at_term', atRisk: false });
    expect(late.jobs).toEqual([]);
    expect(late.renewals[0]?.kind).toBe('check_autopay');

    // The old end reported half an hour before the new one showed: the device
    // refreshing its cached subscription around the renewal, not a lapse.
    const refresh = engineOf({
      A: renewal(E2, at(-20, 14), (k) =>
        k === -20 ? { expired_events: 1, expired_reports: ends([[E1, at(-20, 13.5)]]) } : {}
      ),
    }).evaluate(T0);
    expect(assessment(refresh, 'A')?.renewalStyle).toBe('at_term');

    // Used while the old end had passed (13:30), hours before the renewal showed (18:00): a repurchase.
    const between = engineOf({
      A: renewal(E2, at(-20, 18), (k) =>
        k === -20 ? { expired_events: 1, expired_reports: ends([[E1, at(-20, 13.5)]]) } : {}
      ),
    }).evaluate(T0);
    expect(assessment(between, 'A')?.renewalStyle).toBe('repurchase');
  });

  it('a passed end another device keeps reporting does not make later renewals repurchases', () => {
    const E2 = E1 + 30 * DAY;
    const stale = E1 - 30 * DAY;
    const snap = engineOf({
      A: renewal(E2, at(-20, 14), (k, day) => ({
        // A TV still caches the end of two terms ago and is used every day.
        expired_events: 4,
        expired_reports: ends([[stale, day + 30 * 60]]),
      })),
    }).evaluate(T0);
    expect(assessment(snap, 'A')).toMatchObject({ renewalStyle: 'at_term', expiry: E2, atRisk: false });
  });

  it('no renewal style from ends first seen together on the first history day (a stale one and the current one)', () => {
    // An annual plan: no renewal inside the history; a TV keeps last year's end and reports it as passed.
    const current = T0 + 5 * DAY + 13 * HOUR;
    const lastYear = current - 365 * DAY;
    const snap = engineOf({
      A: (k, day) => ({
        expiry_seen: ends([
          [lastYear, day + HOUR],
          [current, day + 2 * HOUR],
        ]),
        expired_events: 3,
        expired_reports: ends([[lastYear, day + HOUR]]),
      }),
    }).evaluate(T0);
    expect(assessment(snap, 'A')).toMatchObject({ renewalStyle: 'unknown', expiry: current, atRisk: false });
    expect(snap.jobs).toEqual([]);
    expect(snap.renewals).toEqual([expect.objectContaining({ account: 'A', kind: 'check_autopay' })]);
  });

  it('unknown without a renewal in the history', () => {
    const end = T0 + 5 * DAY + 13 * HOUR;
    const snap = engineOf({ A: () => ({ expiry_seen: ends([[end, T0]]) }) }).evaluate(T0);
    expect(assessment(snap, 'A')).toMatchObject({ renewalStyle: 'unknown', expiry: end, atRisk: false });
    expect(snap.renewals[0]?.kind).toBe('check_autopay');
    expect(snap.quality.renewalStyles).toEqual({ at_term: 0, early: 0, repurchase: 0, unknown: 1 });
  });

  it('ignores the stale end a second device keeps showing', () => {
    const E2 = E1 + 30 * DAY;
    const snap = engineOf({
      A: (k, day) => {
        const own = renewal(E2, at(-20, 14))(k, day);
        // From k -10 on, another device still reports the old (passed) end.
        return k >= -10
          ? {
              expiry_seen: ends([
                [E1, day + HOUR],
                [E2, day + 2 * HOUR],
              ]),
              expired_events: 2,
            }
          : own;
      },
    }).evaluate(T0);
    expect(assessment(snap, 'A')).toMatchObject({
      renewalStyle: 'at_term',
      expiry: E2,
      deactivatedAt: null,
      atRisk: false,
    });
    expect(codes(assessment(snap, 'A')?.evidence)).not.toContain('LAPSED');
  });

  it('deactivation: the end moved back to the moment it was seen → support, no offer', () => {
    const end = T0 + 15 * DAY + 13 * HOUR;
    const seen = at(-3, 10);
    const voided = seen - 2;
    const snap = engineOf({
      A: (k, day) =>
        k < -3
          ? { expiry_seen: ends([[end, day + HOUR]]) }
          : k === -3
            ? {
                expiry_seen: ends([
                  [end, day + 8 * HOUR],
                  [voided, seen],
                ]),
              }
            : { expiry_seen: ends([[voided, day + HOUR]]), expired_events: 10, inactive_attempts: 2 },
    }).evaluate(T0);
    const a = assessment(snap, 'A');
    expect(a).toMatchObject({ deactivatedAt: seen, expiry: voided, atRisk: false });
    expect(codes(a?.evidence)).toEqual(expect.arrayContaining(['DEACTIVATED', 'INACTIVE_ATTEMPTS']));
    expect(codes(a?.evidence)).not.toContain('LAPSED');
    expect(snap.support.map((s) => s.account)).toEqual(['A']);
    expect(snap.jobs).toEqual([]);
  });

  describe('a deactivated subscription is support only, whatever else shows', () => {
    const end = T0 + 15 * DAY + 13 * HOUR;
    const seen = at(-9, 10);
    const voided = seen - 2;
    const voidedOn = (after: (k: number, day: number) => Partial<AccountDayRow> | null): Gen => {
      return (k, day) =>
        k < -9
          ? { expiry_seen: ends([[end, day + HOUR]]) }
          : k === -9
            ? {
                expiry_seen: ends([
                  [end, day + 8 * HOUR],
                  [voided, seen],
                ]),
              }
            : after(k, day);
    };
    const refused = (day: number): Partial<AccountDayRow> => ({
      expiry_seen: ends([[voided, day + HOUR]]),
      expired_reports: ends([[voided, day + HOUR]]),
      inactive_attempts: 2,
      watch_all_min: 0,
      live_min: 0,
    });

    it('voided, two refused days, then silent: no marketing job', () => {
      const snap = engineOf({ A: voidedOn((k, day) => (k === -8 ? refused(day) : null)) }).evaluate(T0);
      const a = assessment(snap, 'A');
      expect(codes(a?.evidence)).toEqual(expect.arrayContaining(['QUIET', 'DEACTIVATED']));
      expect(a).toMatchObject({ deactivated: true, deactivatedAt: seen, atRisk: false });
      expect(snap.jobs).toEqual([]);
      expect(snap.support.map((s) => s.account)).toEqual(['A']);
    });

    it('voided, then refused every day without watching: no marketing job', () => {
      const snap = engineOf({
        A: voidedOn((k, day) => refused(day)),
        B: daily,
        C: daily,
        D: daily,
      }).evaluate(T0);
      const a = assessment(snap, 'A');
      expect(codes(a?.evidence)).toEqual(expect.arrayContaining(['FADING', 'INACTIVE_ATTEMPTS', 'DEACTIVATED']));
      expect(a).toMatchObject({ deactivated: true, atRisk: false });
      expect(jobOf(snap, 'A')).toBeUndefined();
      expect(snap.support.map((s) => s.account)).toEqual(['A']);
      // A deactivation older than the lookback is history, not a support case.
      expect(assessment(snap, 'B')?.deactivated).toBe(false);
    });

    it('voided, bought again the next day, then silent: a customer to keep again', () => {
      const end2 = T0 + 30 * DAY + 10 * HOUR;
      const snap = engineOf({
        A: voidedOn((k, day) =>
          k === -8
            ? { expiry_seen: ends([[end2, at(-8, 10)]]) }
            : k <= -6
              ? { expiry_seen: ends([[end2, day + HOUR]]) }
              : null
        ),
        B: daily,
        C: daily,
        D: daily,
      }).evaluate(T0);
      const a = assessment(snap, 'A');
      // The void stays visible as evidence, but the current end is the new purchase.
      expect(codes(a?.evidence)).toEqual(expect.arrayContaining(['QUIET', 'DEACTIVATED']));
      expect(a).toMatchObject({ deactivated: false, expiry: end2, atRisk: true });
      expect(jobOf(snap, 'A')).toBeDefined();
      expect(snap.support.map((s) => s.account)).not.toContain('A');
    });
  });

  it('reads a plan without an end as no end', () => {
    const noEnd = Date.UTC(2106, 1, 7, 6, 28, 15) / 1000;
    const snap = engineOf({ A: (k, day) => ({ expiry_seen: ends([[noEnd, day + HOUR]]) }) }).evaluate(T0);
    expect(assessment(snap, 'A')).toMatchObject({ expiry: null, noEnd: true });
    expect(snap.quality.noEnd).toBe(1);
  });
});

describe('KeepEngine subscription signals and price actions', () => {
  const endedAgo = (days: number) => at(-days, 13);
  const expiredFor =
    (end: number): Gen =>
    (k, day) => ({ expiry_seen: ends([[end, day + HOUR]]) });

  it('no lapse from a device that has not refreshed after a renewal the engine already saw', () => {
    const E1 = at(-6, 20);
    const E2 = E1 + 30 * DAY;
    const snap = engineOf({
      A: (k, day) =>
        k < -6
          ? { expiry_seen: ends([[E1, day + HOUR]]) }
          : k === -6
            ? {
                expiry_seen: ends([
                  [E1, day + HOUR],
                  [E2, E1 + 300],
                ]),
              }
            : k <= -2
              ? { expiry_seen: ends([[E2, day + HOUR]]) }
              : // Only the TV is used on the last two days, still showing the old end as passed.
                { expiry_seen: ends([[E1, day + HOUR]]), expired_reports: ends([[E1, day + HOUR]]), expired_events: 3 },
    }).evaluate(T0);
    const a = assessment(snap, 'A');
    expect(codes(a?.evidence)).not.toContain('LAPSED');
    expect(codes(a?.evidence)).toContain('LAPSED_SILENT');
    expect(snap.jobs.filter((j) => j.offerKind === 'win_back')).toEqual([]);
  });

  it('LAPSED: ended 5 days ago and still around → win-back step 1, a payment link', () => {
    const end = endedAgo(5);
    const snap = engineOf({ A: expiredFor(end) }).evaluate(T0);
    const job = jobOf(snap, 'A');
    expect(job).toMatchObject({
      reason: 'price',
      action: 'retention_offer',
      offerKind: 'win_back',
      offerStep: 1,
      offerTool: 'payment_link',
      dueBy: end + 7 * DAY,
      expiry: end,
    });
    expect(job?.evidence[0]).toEqual({ code: 'LAPSED', value: 5.5 });
  });

  it('LAPSED for longer than winBackStep2Days → step 2, a discount or bonus', () => {
    const snap = engineOf({ A: expiredFor(endedAgo(9)) }).evaluate(T0);
    expect(jobOf(snap, 'A')).toMatchObject({ offerStep: 2, offerTool: 'discount_or_bonus', dueBy: null });
  });

  it('job ids: one per win-back step of an end, another for the next step in the same week', () => {
    const end = endedAgo(5);
    const engine = engineOf({ A: expiredFor(end) }, { to: 3 });
    // Sunday of week 40 and Monday of week 41: step 1 of the same end keeps its id.
    const sunday = jobOf(engine.evaluate(at(-1)), 'A');
    const monday = jobOf(engine.evaluate(T0), 'A');
    expect([sunday?.offerStep, monday?.offerStep]).toEqual([1, 1]);
    expect(monday?.id).toBe(hash64Hex(`111|A|retention_offer|win_back|1|${end}`));
    expect(sunday?.id).toBe(monday?.id);
    // Thursday of week 41: step 2 is another job, so a receiver that keeps one per id does not drop it.
    const thursday = jobOf(engine.evaluate(at(3)), 'A');
    expect(thursday?.offerStep).toBe(2);
    expect(thursday?.id).toBe(hash64Hex(`111|A|retention_offer|win_back|2|${end}`));
    expect(thursday?.id).not.toBe(monday?.id);
  });

  it('LAPSED waits the grace days (automatic payment retries) unless a playback was refused', () => {
    const end = endedAgo(1);
    expect(jobOf(engineOf({ A: expiredFor(end) }).evaluate(T0), 'A')).toBeUndefined();
    const refused = engineOf({
      A: (k, day) => ({ expiry_seen: ends([[end, day + HOUR]]), inactive_attempts: k === 0 ? 1 : 0 }),
    }).evaluate(T0);
    expect(jobOf(refused, 'A')).toMatchObject({ offerKind: 'win_back', offerStep: 1 });
    expect(codes(jobOf(refused, 'A')?.evidence).slice(0, 2)).toEqual(['LAPSED', 'INACTIVE_ATTEMPTS']);
  });

  describe('LAPSED needs a device that reports ends to show the end passed', () => {
    const end = at(-5, 14);
    const stb: Partial<AccountDayRow> = {
      events: 30,
      legacy_events: 30,
      gated_plays: 0,
      ungated_plays: 5,
      watch_all_min: 0,
      live_min: 0,
      watch_min: 0,
      expiry_seen: '',
      expired_reports: '',
      seeds: '',
      hours: '',
      tz_offset_h: -99,
      platforms: 'STB',
    };
    /** The phone reports the end until day -10; from day -9 the household watches on a set-top box only. */
    const movedToStb =
      (extra: (k: number, day: number) => Partial<AccountDayRow> = () => ({})): Gen =>
      (k, day) =>
        k <= -10 ? { expiry_seen: ends([[end, day + HOUR]]) } : { ...stb, ...extra(k, day) };

    it('an end left over from the renewal chain plus set-top box activity: check in the CRM, no offer', () => {
      const snap = engineOf({ A: movedToStb() }).evaluate(T0);
      const a = assessment(snap, 'A');
      expect(a?.expiry).toBe(end);
      expect(codes(a?.evidence)).not.toContain('LAPSED');
      expect(codes(a?.evidence)).toContain('LAPSED_SILENT');
      expect(jobOf(snap, 'A')?.offerKind).not.toBe('win_back');
      expect(snap.renewals).toEqual([expect.objectContaining({ account: 'A', kind: 'expired_silent' })]);
    });

    it('the end reported as passed on the day it ended: lapsed', () => {
      const snap = engineOf({
        A: movedToStb((k, day) =>
          k === -5 ? { events: 34, legacy_events: 30, expired_reports: ends([[end, day + 15 * HOUR]]) } : {}
        ),
      }).evaluate(T0);
      expect(codes(assessment(snap, 'A')?.evidence)).toContain('LAPSED');
      expect(jobOf(snap, 'A')).toMatchObject({ offerKind: 'win_back', offerStep: 1 });
    });

    it('a device that reports ends used after it: lapsed', () => {
      const snap = engineOf({ A: movedToStb((k) => (k === -2 ? { events: 34, legacy_events: 30 } : {})) }).evaluate(T0);
      expect(codes(assessment(snap, 'A')?.evidence)).toContain('LAPSED');
    });

    it('playbacks refused after it: lapsed', () => {
      const snap = engineOf({ A: movedToStb((k) => (k === -3 ? { inactive_attempts: 1 } : {})) }).evaluate(T0);
      expect(codes(assessment(snap, 'A')?.evidence)).toContain('LAPSED');
    });
  });

  it('expired and silent since: listed for a CRM check, not as a lapse', () => {
    const end = endedAgo(6);
    const snap = engineOf({ A: (k, day) => (k <= -7 ? { expiry_seen: ends([[end, day + HOUR]]) } : null) }).evaluate(
      T0
    );
    expect(codes(assessment(snap, 'A')?.evidence)).toEqual(expect.arrayContaining(['QUIET', 'LAPSED_SILENT']));
    expect(snap.renewals).toEqual([expect.objectContaining({ account: 'A', kind: 'expired_silent', expiry: end })]);
    // Silent: the favourite title is "gone" like everything else, which is no content evidence.
    expect(jobOf(snap, 'A')?.action).toBe('re_engagement');
    expect(codes(jobOf(snap, 'A')?.evidence)).not.toContain('TOP_TITLE_GONE');
  });

  it('DOWNGRADE: paid baseline plan, free plan now → win back from free', () => {
    const snap = engineOf({ A: (k) => ({ plan: k >= -6 ? 'Free' : 'Premium' }) }).evaluate(T0);
    expect(assessment(snap, 'A')).toMatchObject({ eligible: true, baselinePlan: 'Premium', latestPlan: 'Free' });
    expect(jobOf(snap, 'A')).toMatchObject({
      reason: 'price',
      action: 'retention_offer',
      offerKind: 'win_back_free',
      offerTool: 'plan_change',
      plan: 'Free',
    });
    expect(jobOf(snap, 'A')?.evidence[0]).toEqual({ code: 'DOWNGRADE', label: 'Free' });
  });

  it('INACTIVE with an active subscription → upgrade; with the end passed → win-back', () => {
    const active = engineOf({ A: (k) => ({ inactive_attempts: k === -1 ? 2 : 0 }) }).evaluate(T0);
    expect(jobOf(active, 'A')).toMatchObject({ reason: 'price', offerKind: 'upgrade', offerTool: 'plan_change' });

    const ended = endedAgo(20);
    const passed = engineOf({
      A: (k, day) => ({ expiry_seen: ends([[ended, day + HOUR]]), inactive_attempts: k === -1 ? 2 : 0 }),
    }).evaluate(T0);
    expect(jobOf(passed, 'A')).toMatchObject({ offerKind: 'win_back', offerStep: 2 });
  });

  it('PREMIUM: an upsell lead while engaged, an upgrade offer when fading; pay-per-view never counts', () => {
    const premium = { premium_attempts: 3, premium_paid_content: 0, paywall_title: 'Champions League' };
    const lead = engineOf({ A: (k) => (k === -2 ? premium : {}) }).evaluate(T0);
    expect(assessment(lead, 'A')?.atRisk).toBe(false);
    expect(lead.leads.map((a) => a.account)).toEqual(['A']);
    expect(assessment(lead, 'A')?.evidence).toEqual([
      { code: 'PREMIUM_ATTEMPTS', value: 3, label: 'Champions League' },
    ]);

    const fading = engineOf({ A: watching(6, premium) }).evaluate(T0);
    expect(jobOf(fading, 'A')).toMatchObject({ reason: 'price', offerKind: 'upgrade' });
    expect(fading.leads).toEqual([]);

    const ppv = engineOf({ A: (k) => (k === -2 ? { premium_attempts: 2, premium_paid_content: 2 } : {}) }).evaluate(T0);
    expect(ppv.leads).toEqual([]);
    expect(codes(assessment(ppv, 'A')?.evidence)).toEqual([]);
  });
});

describe('KeepEngine technical problems', () => {
  const failing: Partial<AccountDayRow> = { failed_playbacks: 3, top_err_code: '403/1001' };
  const errors: Gen = (k) => (k === -2 || k === -1 ? failing : {});

  it('lists technical accounts for support without a marketing job', () => {
    const snap = engineOf({ A: errors }).evaluate(T0);
    const a = assessment(snap, 'A');
    expect(a).toMatchObject({ techIssue: true, atRisk: false });
    expect(a?.evidence).toEqual([{ code: 'TECH_ERRORS', value: 0.214, ref: 0, label: '403/1001' }]);
    expect(snap.support.map((s) => s.account)).toEqual(['A']);
    expect(snap.jobs).toEqual([]);
  });

  it('needs errors on enough days and more than twice the usual share', () => {
    const oneDay = engineOf({ A: (k) => (k === -1 ? { failed_playbacks: 4 } : {}) }).evaluate(T0);
    expect(assessment(oneDay, 'A')?.techIssue).toBe(false);
    const usual = engineOf({ A: (k) => (k < -6 && k % 2 === 0 ? { failed_playbacks: 2 } : errors(k, 0)) }).evaluate(T0);
    expect(assessment(usual, 'A')?.techIssue).toBe(false);
  });

  it('flags buffering per watched hour', () => {
    const snap = engineOf({ A: (k) => (k >= -6 ? { buffering_stops: 10 } : {}) }).evaluate(T0);
    expect(assessment(snap, 'A')?.evidence).toEqual([{ code: 'TECH_BUFFERING', value: 10, ref: 0 }]);
  });

  it('turns promotions into support but keeps renewal reminders and payment links', () => {
    const fading = engineOf({ A: watching(6, failing) }).evaluate(T0);
    expect(jobOf(fading, 'A')).toMatchObject({
      reason: 'technical',
      action: 'support',
      offerTool: 'none',
      techIssue: true,
      control: false,
      seeds: [],
      recFallback: false,
    });
    expect(jobOf(fading, 'A')?.evidence[0].code).toBe('TECH_ERRORS');

    const end = at(-5, 13);
    const lapsed = engineOf({
      A: (k, day) => ({ expiry_seen: ends([[end, day + HOUR]]), ...(k === -2 || k === -1 ? failing : {}) }),
    }).evaluate(T0);
    expect(jobOf(lapsed, 'A')).toMatchObject({
      reason: 'price',
      action: 'retention_offer',
      offerStep: 1,
      offerTool: 'payment_link',
      techIssue: true,
    });

    const lapsedLong = engineOf({
      A: (k, day) => ({ expiry_seen: ends([[at(-9, 13), day + HOUR]]), ...(k === -2 || k === -1 ? failing : {}) }),
    }).evaluate(T0);
    expect(jobOf(lapsedLong, 'A')).toMatchObject({ reason: 'technical', action: 'support' });
  });
});

describe('KeepEngine content and engagement actions', () => {
  it('content push when there is content evidence: failed searches', () => {
    const snap = engineOf({ A: watching(6, { failed_search_sessions: 1, search_sessions: 2 }) }).evaluate(T0);
    const job = jobOf(snap, 'A');
    expect(job).toMatchObject({
      reason: 'content',
      action: 'content_push',
      offerTool: 'none',
      recEndpoint: 'tvchannels',
      recFallback: false,
      profileIds: ['p1'],
    });
    expect(job?.seeds).toEqual([
      { profileId: 'p1', contentType: 'tv', contentId: '100', title: 'News 24', minutes: 1680 },
    ]);
    expect(codes(job?.evidence)).toEqual(['FADING', 'FAILED_SEARCH']);
    expect(job?.evidence[1]).toEqual({ code: 'FAILED_SEARCH', value: 7, ref: 14 });
  });

  it('content evidence: the favourite title is gone', () => {
    const show = JSON.stringify([[['p1', 'tvshow', '9', 'The Show'], 3600, 0]]);
    const film = JSON.stringify([[['p2', 'vod', '5', 'A Film'], 360, 0]]);
    const snap = engineOf({
      A: (k) =>
        k >= -6
          ? { watch_all_min: 6, live_min: 0, ondemand_min: 6, seeds: film }
          : { live_min: 0, ondemand_min: 60, seeds: show },
    }).evaluate(T0);
    const job = jobOf(snap, 'A');
    expect(job?.action).toBe('content_push');
    expect(job?.evidence.find((e) => e.code === 'TOP_TITLE_GONE')).toEqual({
      code: 'TOP_TITLE_GONE',
      value: 1,
      label: 'The Show',
    });
    expect(job?.recEndpoint).toBe('tvshows');
    expect(job?.profileIds).toEqual(['p1', 'p2']);
  });

  it('content evidence: fewer distinct titles, favourites removed', () => {
    const snap = engineOf({
      A: (k) =>
        k >= -6
          ? { watch_all_min: 6, distinct_content: 1, fav_removed: k === -1 ? 3 : 0, fav_added: k === -2 ? 1 : 0 }
          : { distinct_content: 4 },
    }).evaluate(T0);
    expect(
      jobOf(snap, 'A')?.evidence.filter((e) => e.code === 'DIVERSITY_DROP' || e.code === 'FAVORITES_REMOVED')
    ).toEqual([
      { code: 'DIVERSITY_DROP', value: 1, ref: 4 },
      { code: 'FAVORITES_REMOVED', value: 3, ref: 1 },
    ]);
  });

  it('re-engagement without content evidence: weaker, from the provider top viewed', () => {
    const snap = engineOf({ A: watching(6) }).evaluate(T0);
    const job = jobOf(snap, 'A');
    expect(job).toMatchObject({ reason: 'disengaged', action: 're_engagement', recFallback: true, seeds: [] });
    // Severity (1 − 0.2) × 0.6; urgency 0 (the end is two months away); value 1 (active every baseline day).
    expect(job?.priorityParts).toEqual({ severity: 0.48, urgency: 0, value: 1 });
    expect(job?.priority).toBe(Math.round(100 * (0.4 * 0.48 + 0.3 * 1)));
    expect(job?.tier).toBe('medium');
    expect(job?.id).toBe(hash64Hex('111|A|re_engagement|||2026-W41'));
  });

  it('a quiet customer whose plan renews automatically: push before the end, as content', () => {
    const E1 = at(-20, 13);
    const E2 = E1 + 30 * DAY;
    const snap = engineOf({
      A: (k, day) =>
        k > -5
          ? null
          : {
              expiry_seen:
                k < -20
                  ? ends([[E1, day + HOUR]])
                  : k === -20
                    ? ends([
                        [E1, day + HOUR],
                        [E2, at(-20, 14)],
                      ])
                    : ends([[E2, day + HOUR]]),
            },
    }).evaluate(T0);
    expect(assessment(snap, 'A')).toMatchObject({ renewalStyle: 'at_term', expiry: E2 });
    expect(jobOf(snap, 'A')).toMatchObject({ action: 're_engagement', dueBy: E2 - 2 * DAY });
    expect(snap.renewals[0]).toMatchObject({ kind: 'at_risk', renewalStyle: 'at_term' });
  });

  it('a quiet customer with an unknown renewal style gets the renewal campaign with a content hook', () => {
    const end = T0 + 5 * DAY + 13 * HOUR;
    const snap = engineOf({ A: (k, day) => (k > -5 ? null : { expiry_seen: ends([[end, day + HOUR]]) }) }).evaluate(T0);
    const job = jobOf(snap, 'A');
    expect(job).toMatchObject({ reason: 'timing', action: 'renewal_campaign' });
    expect(job?.seeds.map((s) => s.contentId)).toEqual(['100']);
    // Steps before the as-of day ended are dropped (the end is 5 days away: all three remain).
    expect(job?.steps.map((s) => s.what)).toEqual(['reminder', 'reminder', 'payment_link']);
  });

  it('drops renewal steps that are already past', () => {
    const end = D_END + 2 * DAY + HOUR;
    const snap = engineOf({ A: (k, day) => (k > -5 ? null : { expiry_seen: ends([[end, day + HOUR]]) }) }).evaluate(T0);
    expect(jobOf(snap, 'A')?.steps.map((s) => s.at)).toEqual([end - DAY, end + DAY]);
    expect(jobOf(snap, 'A')?.priorityParts.urgency).toBe(0.932);
  });
});

describe('KeepEngine delivery, holdout and capacity', () => {
  it('sends a push an hour before the usual viewing hour and calls at 10:00 local the next day', () => {
    const options = { deliveryByPid: parseDeliveryByPid('111=push, 222=crm') };
    const engine = engineOf(
      {
        A: watching(6),
        B: (k) => ({ pid: '222', ...(k >= -6 ? { watch_all_min: 6 } : {}) }),
        C: (k) => ({ pid: '333', ...(k >= -6 ? { watch_all_min: 6 } : {}) }),
      },
      { options }
    );
    const result = engine.evaluate(T0);
    // Peak hour 20 local at UTC+2 → push at 19:00 local = 17:00 UTC.
    expect(jobOf(result, 'A')).toMatchObject({ delivery: 'push', sendAt: D_END + 17 * HOUR });
    expect(assessment(result, 'A')).toMatchObject({ peakHour: 20, tzOffsetH: 2 });
    expect(jobOf(result, 'B')).toMatchObject({ delivery: 'crm', sendAt: D_END + 8 * HOUR });
    expect(jobOf(result, 'C')).toMatchObject({ delivery: 'unset', sendAt: null });
  });

  it('never gives a send time before the as-of day has ended: the first slot from there on', () => {
    const hours = JSON.stringify([[21, 3000]]);
    const engine = engineOf(
      {
        // Peak 21:00 at UTC-4: push at 20:00 local = 00:00 UTC.
        WEST: (k) => ({ tz_offset_h: -4, hours, ...(k >= -6 ? { watch_all_min: 6, live_min: 6 } : {}) }),
        // CRM 10:00 at UTC+12 = 22:00 UTC of the day before.
        EAST: (k) => ({ pid: '222', tz_offset_h: 12, ...(k >= -6 ? { watch_all_min: 6 } : {}) }),
      },
      { options: { deliveryByPid: parseDeliveryByPid('111=push, 222=crm') } }
    );
    const snap = engine.evaluate(T0);
    expect(jobOf(snap, 'WEST')?.sendAt).toBe(D_END);
    expect(jobOf(snap, 'EAST')?.sendAt).toBe(D_END + 22 * HOUR);

    // The day is read three hours after it ended: the slots from then on.
    const later = engine.evaluate(T0, { notBefore: D_END + 3 * HOUR });
    expect(jobOf(later, 'WEST')?.sendAt).toBe(D_END + DAY);
    expect(jobOf(later, 'EAST')?.sendAt).toBe(D_END + 22 * HOUR);
    const next = engine.evaluate(T0, { notBefore: D_END + 23 * HOUR });
    expect(jobOf(next, 'EAST')?.sendAt).toBe(D_END + DAY + 22 * HOUR);
    // A floor inside the as-of day changes nothing.
    expect(jobOf(engine.evaluate(T0, { notBefore: T0 }), 'EAST')?.sendAt).toBe(D_END + 22 * HOUR);
  });

  it('keeps a renewal step whose moment is still ahead in the next slot, drops one that has passed', () => {
    const end = T0 + 5 * DAY + 13 * HOUR;
    const engine = engineOf(
      { A: (k, day) => (k > -5 ? null : { expiry_seen: ends([[end, day + HOUR]]) }) },
      { options: { deliveryByPid: { '111': 'crm' } } }
    );
    // The first reminder (end − 3 d = T0 + 2 d 13:00) is due at 08:00 UTC that day; at 09:00 that slot has passed.
    const rolled = jobOf(engine.evaluate(T0, { notBefore: T0 + 2 * DAY + 9 * HOUR }), 'A');
    expect(rolled?.steps).toEqual([
      { at: T0 + 3 * DAY + 8 * HOUR, channel: 'crm', what: 'reminder' },
      { at: T0 + 4 * DAY + 8 * HOUR, channel: 'crm', what: 'reminder' },
      { at: T0 + 6 * DAY + 8 * HOUR, channel: 'crm', what: 'payment_link' },
    ]);
    expect(rolled?.sendAt).toBe(T0 + 3 * DAY + 8 * HOUR);
    // After its moment the first reminder is gone.
    const dropped = jobOf(engine.evaluate(T0, { notBefore: T0 + 2 * DAY + 14 * HOUR }), 'A');
    expect(dropped?.steps.map((s) => s.at)).toEqual([T0 + 4 * DAY + 8 * HOUR, T0 + 6 * DAY + 8 * HOUR]);
  });

  it('never pulls a send time back to a due moment that has already passed', () => {
    const E1 = at(-20, 13);
    const E2 = E1 + 30 * DAY;
    const engine = engineOf(
      {
        A: (k, day) =>
          k > -5
            ? null
            : {
                expiry_seen:
                  k < -20
                    ? ends([[E1, day + HOUR]])
                    : k === -20
                      ? ends([
                          [E1, day + HOUR],
                          [E2, at(-20, 14)],
                        ])
                      : ends([[E2, day + HOUR]]),
              },
      },
      { options: { deliveryByPid: { '111': 'crm' } } }
    );
    // Due two days before the end (k 8, 13:00); from k 9 on the next slot is 08:00 UTC of k 9.
    const job = jobOf(engine.evaluate(T0, { notBefore: at(9) }), 'A');
    expect(job).toMatchObject({ action: 're_engagement', dueBy: E2 - 2 * DAY, sendAt: at(9, 8) });
    // From k 8 12:00 the next slot (k 9 08:00) is after the due moment, which is still ahead: pulled back to it.
    expect(jobOf(engine.evaluate(T0, { notBefore: at(8, 12) }), 'A')?.sendAt).toBe(E2 - 2 * DAY);
  });

  it('moves renewal steps to the channel hour on their local date', () => {
    const end = T0 + 5 * DAY + 13 * HOUR;
    const snap = engineOf(
      { A: (k, day) => (k > -5 ? null : { expiry_seen: ends([[end, day + HOUR]]) }) },
      { options: { deliveryByPid: { '111': 'crm' } } }
    ).evaluate(T0);
    // 10:00 local at UTC+2 = 08:00 UTC on each step's date.
    expect(jobOf(snap, 'A')?.steps.map((s) => s.at)).toEqual([
      T0 + 2 * DAY + 8 * HOUR,
      T0 + 4 * DAY + 8 * HOUR,
      T0 + 6 * DAY + 8 * HOUR,
    ]);
    expect(jobOf(snap, 'A')?.sendAt).toBe(T0 + 2 * DAY + 8 * HOUR);
  });

  it('draws the control group by a salted hash, the same on every run', () => {
    const gens: Record<string, Gen> = {};
    for (let i = 0; i < 40; i++) {
      gens[`AC-${i}`] = until(-5);
    }
    const engine = engineOf(gens, { rules: { holdoutShare: 0.5, holdoutSalt: 'S1' } });
    const first = engine.evaluate(T0);
    const second = engine.evaluate(T0);
    expect(first.jobs).toHaveLength(40);
    for (const job of first.jobs) {
      expect(job.control).toBe(fnv1a32(`111|${job.account}|S1`) / 2 ** 32 < 0.5);
    }
    expect(second.jobs.map((j) => [j.id, j.control])).toEqual(first.jobs.map((j) => [j.id, j.control]));
    const control = first.jobs.filter((j) => j.control).length;
    expect(control).toBeGreaterThan(0);
    expect(control).toBeLessThan(40);
    // MDE ≈ 2.8 × sqrt(p(1 − p)(1/n_treat + 1/n_control)) with p = 0.2 before any backtest.
    const expected = 100 * 2.8 * Math.sqrt(0.16 * (1 / (40 - control) + 1 / control));
    expect(first.mdePct).toBeCloseTo(expected, 1);

    const salted = feed(new KeepEngine({ ...DEFAULT_KEEP_RULES, holdoutShare: 0.5, holdoutSalt: 'S2' }), gens).evaluate(
      T0
    );
    expect(salted.jobs.map((j) => j.control)).not.toEqual(first.jobs.map((j) => j.control));
  });

  it('defers jobs beyond the daily capacity per action, by priority', () => {
    const lapsedFor =
      (days: number): Gen =>
      (k, day) => ({ expiry_seen: ends([[at(-days, 13), day + HOUR]]) });
    const snap = engineOf(
      { A4: lapsedFor(4), A6: lapsedFor(6), A8: lapsedFor(8), A10: lapsedFor(10), Q: until(-5) },
      { rules: { dailyCapacity: 2 } }
    ).evaluate(T0);
    const offers = snap.jobs.filter((j) => j.action === 'retention_offer');
    expect(offers.map((j) => [j.account, j.deferred])).toEqual([
      ['A4', false],
      ['A6', false],
      ['A8', true],
      ['A10', true],
    ]);
    expect(jobOf(snap, 'Q')?.deferred).toBe(false);
    expect(snap.mdePct).toBeNull();
  });

  it('counts only jobs that will go out in the minimum detectable effect', () => {
    const gens: Record<string, Gen> = {};
    for (let i = 0; i < 40; i++) {
      gens[`AC-${i}`] = until(-5);
    }
    const rules = { holdoutShare: 0.5, holdoutSalt: 'S1' };
    const all = engineOf(gens, { rules }).evaluate(T0);
    const control = all.jobs.filter((j) => j.control).length;
    expect(control * (40 - control)).toBeGreaterThan(0);

    // Five a day: the deferred ones are not treated (yet).
    const capped = engineOf(gens, { rules: { ...rules, dailyCapacity: 5 } }).evaluate(T0);
    expect(capped.jobs.filter((j) => !j.control && !j.deferred)).toHaveLength(5);
    expect(capped.mdePct).toBeCloseTo(100 * 2.8 * Math.sqrt(0.16 * (1 / 5 + 1 / control)), 1);

    // No way to reach the customers: nothing to measure.
    const unreachable = engineOf(gens, { rules, options: { deliveryByPid: { '111': 'none' } } }).evaluate(T0);
    expect(unreachable.jobs).toHaveLength(40);
    expect(unreachable.mdePct).toBeNull();
  });
});

describe('KeepEngine support and leads', () => {
  it('lists the worst cases first: deactivated, then the failed share, then buffering; leads by refused playbacks', () => {
    const end = T0 + 15 * DAY + 13 * HOUR;
    const voided = at(-3, 10) - 2;
    const failing =
      (failed: number): Gen =>
      (k) =>
        k === -2 || k === -1 ? { failed_playbacks: failed } : {};
    const snap = engineOf({
      BUFFER: (k) => (k >= -6 ? { buffering_stops: 10 } : {}),
      FAIL3: failing(3),
      VOID: (k, day) =>
        k < -3
          ? { expiry_seen: ends([[end, day + HOUR]]) }
          : k === -3
            ? {
                expiry_seen: ends([
                  [end, day + 8 * HOUR],
                  [voided, voided + 2],
                ]),
              }
            : { expiry_seen: ends([[voided, day + HOUR]]) },
      FAIL4: failing(4),
      LEAD1: (k) => (k === -2 ? { premium_attempts: 1 } : {}),
      LEAD4: (k) => (k === -2 ? { premium_attempts: 4 } : {}),
      LEAD2: (k) => (k === -2 ? { premium_attempts: 3, premium_paid_content: 1 } : {}),
    }).evaluate(T0);
    expect(snap.support.map((a) => a.account)).toEqual(['VOID', 'FAIL4', 'FAIL3', 'BUFFER']);
    expect(snap.leads.map((a) => a.account)).toEqual(['LEAD4', 'LEAD2', 'LEAD1']);
  });
});

describe('KeepEngine quality', () => {
  it('reports plans per provider with their class and overrides, paywall codes per platform and missing days', () => {
    const engine = engineOf(
      {
        A: (k) =>
          k === -1
            ? {
                inactive_attempts: 2,
                platforms: 'Android,iOS',
                paywall_codes: JSON.stringify([
                  ['iOS|subsctiprionInActive/-', 'Android|-/-103'],
                  [2, 3],
                ]),
              }
            : {},
        B: (k) => ({
          plan: 'Freedom Pack',
          platforms: 'iOS',
          premium_attempts: k === -2 ? 1 : 0,
          // The object shape; '103' (no dash) is a candidate form, not in the paywall definition.
          paywall_codes: k === -2 || k === -3 ? JSON.stringify({ 'iOS|402/-': 1, 'Android|-/103': '2' }) : '',
        }),
        C: (k) => ({ plan: 'Freedom Pack', platforms: k % 2 ? 'Android' : 'iOS' }),
      },
      { options: { planClassOverrides: { '111|Freedom Pack': 'free' } }, rules: { includeFreePlans: true } }
    );
    engine.evictOutside(at(-39), at(-1));
    feed(engine, { A: daily }, { from: 0, to: 0 });
    engine.evictOutside(at(-30), at(0));
    const q = engine.evaluate(T0).quality;
    expect(q.plans).toEqual([
      { pid: '111', plan: 'Freedom Pack', planClass: 'free', overridden: true, accounts: 2 },
      { pid: '111', plan: 'Premium Monthly', planClass: 'paid', overridden: false, accounts: 1 },
    ]);
    expect(q.paywall).toEqual([
      { platform: 'Android', code: '-/103', count: 4, kind: 'candidate' },
      { platform: 'Android', code: '-/-103', count: 3, kind: 'premium' },
      { platform: 'iOS', code: '402/-', count: 2, kind: 'premium' },
      { platform: 'iOS', code: 'subsctiprionInActive/-', count: 2, kind: 'inactive' },
    ]);
    expect(q).toMatchObject({ accounts: 3, eligible: 3, legacyOnly: 0, planUnknown: 0 });
    expect(q.missingDays).toEqual([at(-39), at(-38), at(-37), at(-36), at(-35), at(-34), at(-33), at(-32), at(-31)]);
    expect(q.days).toHaveLength(31);
  });
});

describe('KeepEngine GA4 evidence', () => {
  const engine = () => engineOf({ 'AA-111-111': watching(6), 'BB-222-222': daily });

  it('adds search-without-play as content evidence, matched by provider and account key', () => {
    const e = engine();
    expect(jobOf(e.evaluate(T0), 'AA-111-111')?.action).toBe('re_engagement');
    e.setBehavior({
      status: 'on',
      window: { from: '2026-09-29', to: '2026-10-05', days: 7 },
      matched: 1,
      requested: 1,
      notLinked: 4,
      rows: [
        behavior('AA111111', { searchNoPlaySessions: 3, browseNoPlaySessions: 3 }),
        behavior('BB222222', { pid: '222' }),
      ],
    });
    const snap = e.evaluate(T0);
    const job = jobOf(snap, 'AA-111-111');
    expect(job).toMatchObject({ reason: 'content', action: 'content_push' });
    expect(job?.evidence.filter((x) => x.code.startsWith('GA4_'))).toEqual([
      { code: 'GA4_SEARCH_NO_PLAY', value: 3, ref: 7 },
      { code: 'GA4_BROWSE_NO_PLAY', value: 3, ref: 7 },
    ]);
    expect(assessment(snap, 'AA-111-111')?.behavior?.searchNoPlaySessions).toBe(3);
    // Another provider's row does not match the same account number.
    expect(assessment(snap, 'BB-222-222')?.behavior).toBeUndefined();
    expect(snap.quality.behavior).toEqual({
      status: 'on',
      window: { from: '2026-09-29', to: '2026-10-05', days: 7 },
      matched: 1,
      requested: 1,
      notLinked: 4,
    });

    e.setBehavior(null);
    const cleared = e.evaluate(T0);
    expect(jobOf(cleared, 'AA-111-111')?.action).toBe('re_engagement');
    expect(cleared.quality.behavior).toBeUndefined();
  });

  it('crashes on two days make the account technical', () => {
    const e = engine();
    e.setBehavior({ status: 'on', rows: [behavior('AA111111', { crashes: 4, crashDays: 2, logoutClicks: 1 })] });
    const snap = e.evaluate(T0);
    expect(jobOf(snap, 'AA-111-111')).toMatchObject({ reason: 'technical', action: 'support', techIssue: true });
    expect(codes(jobOf(snap, 'AA-111-111')?.evidence)).toEqual(
      expect.arrayContaining(['GA4_CRASHES', 'GA4_LOGOUT', 'FADING'])
    );
  });
});

describe('KeepEngine backtest', () => {
  const rules: Partial<KeepRules> = {
    recentDays: 7,
    baselineDays: 14,
    renewalHistoryDays: 21,
    outcomeDays: 7,
    labelGraceDays: 2,
    cooldownDays: 14,
  };
  const ended = at(-4, 12);
  const renewedTo = at(2, 8) + 30 * DAY;
  const lapsedUntil =
    (last: number, renewAt?: number): Gen =>
    (k, day) => {
      if (k > last) {
        return null;
      }
      if (renewAt !== undefined && k >= renewAt) {
        return {
          expiry_seen: ends(
            k === renewAt
              ? [
                  [ended, day + HOUR],
                  [renewedTo, at(2, 8)],
                ]
              : [[renewedTo, day + HOUR]]
          ),
        };
      }
      return { expiry_seen: ends([[ended, day + HOUR]]), expired_events: k >= -4 ? 3 : 0 };
    };
  const quietThenBack =
    (back: number[]): Gen =>
    (k) =>
      k <= -7 || back.includes(k) ? {} : k === -6 ? { watch_all_min: 400, live_min: 400 } : null;
  const gens: Record<string, Gen> = {
    RENEWED: lapsedUntil(9, 2),
    GONE: lapsedUntil(9),
    SILENT: lapsedUntil(0),
    QBACK: quietThenBack([1, 2]),
    QGONE: quietThenBack([]),
    STEADY1: daily,
    STEADY2: daily,
    STOP: until(0),
  };
  const backtestEngine = () => engineOf(gens, { rules, from: -20, to: 9, fullFrom: -20 });

  it('labels renewals, lapses and returns, against the eligible accounts that were not flagged', () => {
    const engine = backtestEngine();
    const report = engine.backtest([T0]);
    expect(report).toMatchObject({ asOfs: [T0], horizonDays: 7, suppressedByCooldown: 0 });
    const byGroup = Object.fromEntries(report.rows.map((r) => [r.group, r]));
    // RENEWED renewed, GONE kept the passed end, SILENT never came back: censored.
    expect(byGroup.price).toEqual({
      group: 'price',
      flagged: 3,
      labeled: 2,
      censored: 1,
      positiveRate: 0.5,
      baseRate: 0,
      lift: null,
      recall: 1,
    });
    // QUIET judged by "returned": QBACK came back, QGONE did not; STOP (not flagged) did not either.
    // Recall counts every eligible account that did not return: QGONE, STOP and SILENT (flagged in price).
    expect(byGroup.quiet).toEqual({
      group: 'quiet',
      flagged: 2,
      labeled: 2,
      censored: 0,
      positiveRate: 0.5,
      baseRate: 0.3333,
      lift: 1.5,
      recall: 0.3333,
    });
    expect(byGroup.content).toMatchObject({ flagged: 0, baseRate: 0.3333, lift: null, recall: 0 });
    // GONE's lapse was flagged in price: none of the bad subscription outcomes was flagged in timing.
    expect(byGroup.timing).toMatchObject({ flagged: 0, recall: 0 });

    // The measured base rate (mean over the groups that have one: 1/3) feeds the minimum detectable effect.
    const holdout = engineOf(gens, { rules: { ...rules, holdoutShare: 0.5 }, from: -20, to: 9, fullFrom: -20 });
    holdout.backtest([T0]);
    const snap = holdout.evaluate(T0);
    const control = snap.jobs.filter((j) => j.control).length;
    const treat = snap.jobs.length - control;
    expect(control * treat).toBeGreaterThan(0);
    const p = (0.3333 + 0.3333 + 0.3333) / 3;
    expect(snap.mdePct).toBeCloseTo(100 * 2.8 * Math.sqrt(p * (1 - p) * (1 / treat + 1 / control)), 1);
    expect(snap.backtest).toBeUndefined();
  });

  it('recall: a bad outcome flagged in another group still counts as one this group missed', () => {
    const fadingEnd = at(5, 13);
    const engine = engineOf(
      {
        // Lapsed, still around with the old end, never renews: flagged in price.
        GONE: lapsedUntil(9),
        // Fading only (the end is beyond the renewal window): flagged as disengaged; keeps the end past it.
        F: (k, day) => ({
          expiry_seen: ends([[fadingEnd, day + HOUR]]),
          ...(k >= -6 ? { watch_all_min: 6, live_min: 6 } : {}),
        }),
        STEADY1: daily,
        STEADY2: daily,
        STEADY3: daily,
        STEADY4: daily,
      },
      { rules: { ...rules, renewalWindowDays: 2 }, from: -20, to: 9, fullFrom: -20 }
    );
    const byGroup = Object.fromEntries(engine.backtest([T0]).rows.map((r) => [r.group, r]));
    expect(byGroup.disengaged).toMatchObject({ flagged: 1 });
    // Two eligible accounts did not renew; price flagged one of them.
    expect(byGroup.price).toMatchObject({ flagged: 1, labeled: 1, positiveRate: 1, recall: 0.5 });
    expect(byGroup.timing).toMatchObject({ flagged: 0, recall: 0 });
  });

  it('a quiet customer is judged by "returned" even though silence also lowers the watch time', () => {
    const quiet: Record<string, Gen> = { Q: until(-5) };
    for (let i = 0; i < 10; i++) {
      quiet[`S-${i}`] = daily;
    }
    const engine = engineOf(quiet, { rules, from: -20, to: 9, fullFrom: -20 });
    expect(codes(assessment(engine.evaluate(T0), 'Q')?.evidence)).toEqual(expect.arrayContaining(['QUIET', 'FADING']));
    const byGroup = Object.fromEntries(engine.backtest([T0]).rows.map((r) => [r.group, r]));
    expect(byGroup.quiet).toMatchObject({ flagged: 1, labeled: 1, positiveRate: 1, recall: 1 });
    expect(byGroup.disengaged).toMatchObject({ flagged: 0 });
  });

  it('runs one as-of date per step, keeping the cooldown between steps', () => {
    const quiet: Record<string, Gen> = { Q: (k) => (k <= -7 ? {} : k === -6 ? { watch_all_min: 400 } : null) };
    const engine = engineOf(quiet, { rules, from: -20, to: 16, fullFrom: -20 });
    const session = engine.beginBacktest([T0 + 7 * DAY, T0, T0]);
    expect([session.total, session.done]).toEqual([2, 0]);
    expect(session.step()).toBe(true);
    expect(session.report()).toMatchObject({ asOfs: [T0], suppressedByCooldown: 0 });
    expect(session.done).toBe(1);
    expect(session.step()).toBe(true);
    expect(session.step()).toBe(false);
    const report = session.report();
    expect(report).toMatchObject({ asOfs: [T0, T0 + 7 * DAY], suppressedByCooldown: 1 });
    expect(report).toEqual(engine.backtest([T0, T0 + 7 * DAY]));
  });

  it('censors engagement labels when a horizon day is missing', () => {
    const engine = backtestEngine();
    engine.evictOutside(at(-20), at(2));
    const report = engine.backtest([T0]);
    const quiet = report.rows.find((r) => r.group === 'quiet');
    expect(quiet).toMatchObject({ flagged: 2, labeled: 0, censored: 2 });
    // The renewal was seen inside the days still held.
    expect(report.rows.find((r) => r.group === 'price')).toMatchObject({ labeled: 2, censored: 1 });
  });

  it('applies the cooldown between jobs of the same account across as-of dates', () => {
    const quiet: Record<string, Gen> = { Q: (k) => (k <= -7 ? {} : k === -6 ? { watch_all_min: 400 } : null) };
    const withCooldown = engineOf(quiet, { rules, from: -20, to: 16, fullFrom: -20 }).backtest([T0, T0 + 7 * DAY]);
    const flagged = (r: typeof withCooldown) => r.rows.reduce((sum, row) => sum + row.flagged, 0);
    expect(withCooldown.suppressedByCooldown).toBe(1);
    expect(flagged(withCooldown)).toBe(1);

    const noCooldown = engineOf(quiet, {
      rules: { ...rules, cooldownDays: 0 },
      from: -20,
      to: 16,
      fullFrom: -20,
    }).backtest([T0, T0 + 7 * DAY]);
    expect(noCooldown.suppressedByCooldown).toBe(0);
    expect(flagged(noCooldown)).toBe(2);
  });
});

describe('KeepEngine performance', () => {
  /** A synthetic day of `n` accounts in columnar form, like a datasource frame. */
  function syntheticDay(k: number, accounts: string[]): DayBlock {
    const day = at(k);
    const n = accounts.length;
    const active: number[] = [];
    for (let i = 0; i < n; i++) {
      // Every tenth account is silent in the recent window.
      if (!(i % 10 === 0 && k > -5)) {
        active.push(i);
      }
    }
    const m = active.length;
    const columns = new Map<string, ArrayLike<unknown>>();
    const numeric = (f: (i: number) => number) => Float64Array.from(active, f);
    const endCell = ends([[FAR, day + HOUR]]);
    const seedCell = JSON.stringify([[['p1', 'tv', '100', 'News 24'], 3600, 0]]);
    const hourCell = JSON.stringify([[20, 3000]]);
    columns.set('pid', new Array(m).fill('111'));
    columns.set(
      'account',
      active.map((i) => accounts[i])
    );
    columns.set(
      'events',
      numeric(() => 40)
    );
    columns.set(
      'legacy_events',
      numeric((i) => (i % 7 === 0 ? 10 : 0))
    );
    columns.set(
      'gated_plays',
      numeric(() => 4)
    );
    columns.set(
      'ungated_plays',
      numeric((i) => (i % 7 === 0 ? 2 : 0))
    );
    // Every tenth (offset 1) account fades in the recent window.
    columns.set(
      'watch_all_min',
      numeric((i) => (i % 10 === 1 && k >= -6 ? 5 : 30 + (i % 90)))
    );
    columns.set(
      'live_min',
      numeric(() => 30)
    );
    columns.set('expiry_seen', new Array(m).fill(endCell));
    columns.set(
      'expired_events',
      numeric(() => 0)
    );
    columns.set(
      'inactive_attempts',
      numeric((i) => (i % 997 === 0 ? 1 : 0))
    );
    columns.set('plan', new Array(m).fill('Premium Monthly'));
    columns.set(
      'first_ts',
      numeric(() => day + HOUR)
    );
    columns.set(
      'last_ts',
      numeric(() => day + 20 * HOUR)
    );
    columns.set(
      'platforms',
      active.map((i) => (i % 3 ? 'Android' : 'iOS'))
    );
    columns.set(
      'distinct_content',
      numeric(() => 3)
    );
    columns.set(
      'playbacks',
      numeric(() => 4)
    );
    columns.set(
      'failed_playbacks',
      numeric((i) => (i % 501 === 0 ? 2 : 0))
    );
    columns.set(
      'seeds',
      active.map((i) => (i % 5 ? '' : seedCell))
    );
    columns.set(
      'hours',
      active.map((i) => (i % 5 ? '' : hourCell))
    );
    columns.set(
      'tz_offset_h',
      numeric(() => 2)
    );
    return { day, level: 'full', from: day, to: day + DAY, length: m, column: (name) => columns.get(name) };
  }

  it('evaluates 50k accounts × 28 days in linear time', () => {
    const accounts = Array.from({ length: 50_000 }, (_, i) => `AC-${String(i).padStart(6, '0')}`);
    const engine = new KeepEngine(DEFAULT_KEEP_RULES);
    const t0 = performance.now();
    for (let k = -27; k <= 0; k++) {
      engine.ingestDay(syntheticDay(k, accounts));
    }
    const t1 = performance.now();
    const snap = engine.evaluate(T0);
    const t2 = performance.now();
    if (process.env.KEEP_PERF_LOG) {
      process.stdout.write(
        `keep perf: ingest ${Math.round(t1 - t0)} ms, evaluate ${Math.round(t2 - t1)} ms, ` +
          `${snap.assessments.length} accounts, ${snap.jobs.length} jobs\n`
      );
    }
    expect(snap.assessments).toHaveLength(50_000);
    expect(snap.jobs.length).toBeGreaterThan(9_000);
    // ~0.7 s on a laptop; the bound leaves room for slow shared CI runners and
    // still catches a pass that stops being linear.
    expect(t2 - t1).toBeLessThan(5000);
  }, 60_000);
});
