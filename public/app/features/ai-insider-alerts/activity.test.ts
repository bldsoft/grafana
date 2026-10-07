import { ActivityDetector } from './activity';
import { ActivityBucketRow, DEFAULT_RULES } from './types';

const DAY = 86400;
const B = 300;
/** A Monday noon; three previous days are read as the usual level. */
const T0 = Date.UTC(2026, 8, 28, 12) / 1000;
const W = 4 * 3600;

type Level = Omit<ActivityBucketRow, 'bucket' | 'pid'>;
const NORMAL: Level = { users: 300, sessions: 40, plays: 400, errEvents: 6, events: 2000 };

/** One window of rows: every provider at its normal level unless `at` says otherwise. */
function rows(
  from: number,
  to: number,
  pids: string[],
  at: (bucket: number, pid: string) => Level | null = () => NORMAL
) {
  const out: ActivityBucketRow[] = [];
  for (let b = from; b < to; b += B) {
    for (const pid of pids) {
      const level = at(b, pid);
      if (level) {
        out.push({ bucket: b, pid, ...level });
      }
    }
  }
  return out;
}

/** A detector that has read three normal days before T0 for these providers. */
function detector(pids: string[]) {
  const d = new ActivityDetector(DEFAULT_RULES);
  for (let day = 1; day <= 3; day++) {
    d.ingestBaseline(rows(T0 - day * DAY, T0 - day * DAY + W, pids), T0 - day * DAY, T0 - day * DAY + W);
  }
  return d;
}

const PIDS = Array.from({ length: 12 }, (_, i) => String(300 + i));
const inWindow = (b: number, from: number, to: number) => b >= T0 + from * 60 && b < T0 + to * 60;

describe('ActivityDetector', () => {
  it('stays quiet on a normal day', () => {
    const d = detector(PIDS);
    d.ingest(rows(T0, T0 + W, PIDS), T0, T0 + W);
    expect(d.getIncidents()).toEqual([]);
  });

  it('confirms a service outage after 15 minutes of app starts without playback, and closes it', () => {
    const d = detector(PIDS);
    d.ingest(
      rows(T0, T0 + W, PIDS, (b, pid) =>
        pid === '305' && inWindow(b, 60, 90) ? { ...NORMAL, sessions: 200, plays: 40, errEvents: 0 } : NORMAL
      ),
      T0,
      T0 + W
    );
    const [inc] = d.getIncidents();
    expect(inc).toMatchObject({
      kind: 'service_down',
      pid: '305',
      start: T0 + 60 * 60,
      detectedAt: T0 + 75 * 60,
      closedAt: T0 + 90 * 60,
    });
    expect(d.covers('305', T0 + 70 * 60, T0 + 80 * 60)).toBe(true);
    expect(d.covers('306', T0 + 70 * 60, T0 + 80 * 60)).toBe(false);
  });

  it('does not confirm a 10-minute storm', () => {
    const d = detector(PIDS);
    d.ingest(
      rows(T0, T0 + W, PIDS, (b, pid) =>
        pid === '305' && inWindow(b, 60, 70) ? { ...NORMAL, sessions: 200, plays: 40 } : NORMAL
      ),
      T0,
      T0 + W
    );
    expect(d.getIncidents()).toEqual([]);
  });

  it('reads silence from many providers as "no data", not as an outage', () => {
    const d = detector(PIDS);
    // The intake drops every event for 10 minutes.
    d.ingest(
      rows(T0, T0 + W, PIDS, (b) => (inWindow(b, 60, 70) ? null : NORMAL)),
      T0,
      T0 + W
    );
    const incidents = d.getIncidents();
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ kind: 'no_data', start: T0 + 60 * 60, closedAt: T0 + 70 * 60 });
    expect(Object.keys(incidents[0].pids)).toHaveLength(12);
  });

  it('groups ten providers losing playback at once into one outage', () => {
    const d = detector(PIDS);
    const hit = new Set(PIDS.slice(0, 10));
    d.ingest(
      rows(T0, T0 + W, PIDS, (b, pid) =>
        hit.has(pid) && inWindow(b, 60, 80) ? { ...NORMAL, plays: 100, errEvents: 80 } : NORMAL
      ),
      T0,
      T0 + W
    );
    const [inc] = d.getIncidents();
    expect(inc).toMatchObject({ kind: 'outage', start: T0 + 60 * 60, detectedAt: T0 + 70 * 60 });
    expect(Object.keys(inc.pids).sort()).toEqual([...hit].sort());
  });

  it('folds the service outages of its members into one cross-provider outage', () => {
    const d = detector(PIDS);
    const hit = new Set(PIDS.slice(0, 9));
    d.ingest(
      rows(T0, T0 + W, PIDS, (b, pid) =>
        hit.has(pid) && inWindow(b, 60, 90) ? { ...NORMAL, sessions: 200, plays: 40 } : NORMAL
      ),
      T0,
      T0 + W
    );
    expect(d.getIncidents().map((i) => i.kind)).toEqual(['outage']);
  });

  it('says nothing without previous days to compare with', () => {
    const d = new ActivityDetector(DEFAULT_RULES);
    d.ingest(
      rows(T0, T0 + W, PIDS, (b) => (inWindow(b, 60, 90) ? null : NORMAL)),
      T0,
      T0 + W
    );
    expect(d.getIncidents()).toEqual([]);
  });
});
