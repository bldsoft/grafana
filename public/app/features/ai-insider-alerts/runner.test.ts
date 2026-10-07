import { AlertEngine } from './engine';
import { runLive, runReplay } from './runner';
import { DEFAULT_RULES } from './types';

const runRawQuery = jest.fn();

jest.mock('app/features/dashboard-scene/ai-panel/datasourceQuery', () => ({
  runRawQuery: (...args: unknown[]) => runRawQuery(...args),
}));

const H0 = Date.UTC(2026, 8, 29, 17) / 1000;
const MIN = 60;
const DS = { uid: 'ch', type: 'grafana-clickhouse-datasource' };

/** Sport 1 (222) fails from minute 10 to minute 39 of the first hour, then is watched cleanly. */
const failing = (minute: number) => minute >= H0 + 10 * MIN && minute < H0 + 40 * MIN;

function minuteRow(minute: number) {
  const bad = failing(minute);
  return {
    minute_ts: minute,
    pid: '222',
    cid: '20002549',
    channel_title: 'Sport 1',
    users: 100,
    err_users: bad ? 60 : 0,
    err_events: bad ? 120 : 0,
    srv_err_users: bad ? 55 : 0,
    top_code: bad ? '403/1001' : '',
  };
}

function minutesOf(from: number, to: number) {
  return Array.from({ length: (to - from) / MIN }, (_, i) => minuteRow(from + i * MIN));
}

/** Answers by query shape, over the window in the WHERE clause. */
function answer(sql: string) {
  const bounds = /event_timestamp >= toDateTime\((\d+)\) AND event_timestamp < toDateTime\((\d+)\)/.exec(sql);
  if (!bounds) {
    return [];
  }
  const window = minutesOf(Number(bounds[1]), Number(bounds[2]));
  if (sql.includes('GROUP BY inc, user_id')) {
    return [{ inc: 0, user_id: 'AA-111-111', first_err: H0 + 10 * MIN, last_err: H0 + 39 * MIN, err_events: 30 }];
  }
  if (sql.includes('HAVING users >=')) {
    return window.filter((r) => failing(r.minute_ts));
  }
  if (sql.includes('(content_provider_id, event_parameter1) IN')) {
    return window;
  }
  return [];
}

/** The parts of a run that must not depend on how it was split up. */
function outcome(engine: AlertEngine) {
  return {
    incidents: engine.getIncidents().map((i) => ({
      start: i.start,
      detectedAt: i.detectedAt,
      closedAt: i.closedAt,
      recovered: i.recovered,
      viewers: engine.getAffectedUsers(i.id).map((u) => u.userId),
    })),
    decisions: engine.getDecisions().map((d) => [d.kind, d.at, d.userId]),
  };
}

const replay = (engine: AlertEngine) =>
  runReplay({
    datasource: DS,
    pids: ['222'],
    engine,
    signal: new AbortController().signal,
    onChunk: () => {},
    from: H0,
    to: H0 + 3 * 3600,
    step: 900,
  });

describe('runReplay', () => {
  beforeEach(() => {
    runRawQuery.mockReset();
    runRawQuery.mockImplementation((_ds: unknown, sql: string) =>
      Promise.resolve({ data: answer(sql), truncated: false })
    );
  });

  it('continues a replay stopped by a failed read with the same result as an uninterrupted one', async () => {
    const whole = new AlertEngine(DEFAULT_RULES);
    await replay(whole);
    expect(whole.getIncidents()).toHaveLength(1);

    // The channel minutes of the window at 17:30 fail once, after the
    // discovery query of that window already answered.
    let failures = 1;
    runRawQuery.mockImplementation((_ds: unknown, sql: string) => {
      const channelMinutes = sql.includes('IN ((') && !sql.includes('GROUP BY inc');
      if (failures > 0 && channelMinutes && sql.includes(`event_timestamp >= toDateTime(${H0 + 30 * MIN})`)) {
        failures -= 1;
        return Promise.reject(new Error('Code: 62. DB::Exception: Syntax error'));
      }
      return Promise.resolve({ data: answer(sql), truncated: false });
    });
    const split = new AlertEngine(DEFAULT_RULES);
    await expect(replay(split)).rejects.toThrow('Syntax error');
    expect(split.processedTo).toBe(H0 + 30 * MIN);

    await replay(split);
    expect(split.processedTo).toBe(H0 + 3 * 3600);
    expect(outcome(split)).toEqual(outcome(whole));
  });

  it('keeps an incident pending when its viewers fail to load, and reads them on the next run', async () => {
    let failures = 1;
    runRawQuery.mockImplementation((_ds: unknown, sql: string) => {
      if (failures > 0 && sql.includes('GROUP BY inc, user_id')) {
        failures -= 1;
        return Promise.reject(new Error('Code: 241. DB::Exception: Memory limit exceeded'));
      }
      return Promise.resolve({ data: answer(sql), truncated: false });
    });
    const engine = new AlertEngine(DEFAULT_RULES);
    await expect(replay(engine)).rejects.toThrow('Memory limit');
    const [incident] = engine.getIncidents();
    expect(engine.getAffectedUsers(incident.id)).toEqual([]);

    await replay(engine);
    expect(engine.getAffectedUsers(incident.id).map((u) => u.userId)).toEqual(['AA-111-111']);
  });
});

describe('runLive', () => {
  it('keeps watching through a failed step and processes the same minutes on the next poll', async () => {
    let clock = H0 + 3600 + 2 * MIN;
    let failures = 1;
    runRawQuery.mockReset();
    runRawQuery.mockImplementation((_ds: unknown, sql: string) => {
      if (failures > 0 && sql.includes('HAVING users >=')) {
        failures -= 1;
        return Promise.reject(new Error('Code: 241. DB::Exception: Memory limit exceeded'));
      }
      return Promise.resolve({ data: answer(sql), truncated: false });
    });
    const engine = new AlertEngine(DEFAULT_RULES);
    const controller = new AbortController();
    const errors: Array<[string, number]> = [];
    const done: number[] = [];
    await runLive({
      datasource: DS,
      pids: ['222'],
      engine,
      signal: controller.signal,
      pollMs: 0,
      now: () => clock,
      onLiveError: (message, at) => errors.push([message, at]),
      onChunk: (to) => {
        done.push(to);
        clock += MIN;
        if (done.length === 3) {
          controller.abort();
        }
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toContain('Memory limit');
    // The warm-up hour failed, then was processed whole on the next poll.
    expect(errors[0][1]).toBe(H0);
    expect(done).toEqual([H0 + 3600, H0 + 3600 + MIN, H0 + 3600 + 2 * MIN]);
    expect(engine.getIncidents()).toHaveLength(1);
  });
});
