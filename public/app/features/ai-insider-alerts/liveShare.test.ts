import { snapshot } from './fixtures/snapshot';
import {
  ShareStatus,
  ShareUnavailableError,
  SyncResult,
  deserializeSnapshot,
  liveRoom,
  rulesHash,
  runSharedLive,
  serializeSnapshot,
} from './liveShare';
import { DEFAULT_RULES } from './types';

const room = liveRoom('ds-1', ['222', '111'], DEFAULT_RULES);

function fakeApi(roles: Array<SyncResult['role'] | 'down'>) {
  const calls = { publish: 0, fetch: 0, leave: 0 };
  let i = 0;
  let version = 0;
  return {
    calls,
    api: {
      sync: jest.fn(async () => {
        const role = roles[Math.min(i++, roles.length - 1)];
        if (role === 'down') {
          throw new ShareUnavailableError('not reachable');
        }
        version++;
        return { role, version, at: 100, watchers: 2 };
      }),
      fetch: jest.fn(async () => {
        calls.fetch++;
        return deserializeSnapshot(JSON.parse(JSON.stringify(serializeSnapshot(snapshot()))));
      }),
      publish: jest.fn(async () => {
        calls.publish++;
        return true;
      }),
      leave: jest.fn(() => {
        calls.leave++;
      }),
    },
  };
}

describe('shared Live', () => {
  it('carries a snapshot through JSON with its viewers and classes', () => {
    const snap = snapshot();
    const back = deserializeSnapshot(JSON.parse(JSON.stringify(serializeSnapshot(snap))))!;
    expect(back.incidents).toEqual(snap.incidents);
    expect(back.decisions).toEqual(snap.decisions);
    const sport = snap.incidents.find((i) => i.title === 'Sport 1')!;
    expect(back.classOf(sport)).toBe(snap.classOf(sport));
    expect(back.affected(sport.id)).toEqual(snap.affected(sport.id));
    expect(back.affected('nope')).toEqual([]);
    expect(deserializeSnapshot({ ...serializeSnapshot(snap), v: 99 })).toBeUndefined();
    expect(deserializeSnapshot('x')).toBeUndefined();
  });

  it('keys the room by sorted providers and the rules', () => {
    expect(room.pids).toEqual(['111', '222']);
    expect(rulesHash({ ...DEFAULT_RULES })).toBe(room.rulesHash);
    expect(rulesHash({ ...DEFAULT_RULES, minUsers: 9 })).not.toBe(room.rulesHash);
  });

  it('runs its own Live when the service has no shared Live', async () => {
    const { api } = fakeApi(['down']);
    const runOwn = jest.fn(async () => undefined);
    const statuses: ShareStatus[] = [];
    await runSharedLive({
      room,
      clientId: 'client-test',
      signal: new AbortController().signal,
      runOwn,
      onSnapshot: jest.fn(),
      onStatus: (s) => statuses.push(s),
      api,
    });
    expect(runOwn).toHaveBeenCalledTimes(1);
    expect(statuses[0].mode).toBe('local');
  });

  it('follows the leader, then takes over when the lease comes to it', async () => {
    const { api, calls } = fakeApi(['follower', 'follower', 'leader']);
    const controller = new AbortController();
    const onSnapshot = jest.fn();
    const statuses: ShareStatus[] = [];
    const runOwn = jest.fn(async (signal: AbortSignal, publish: (s: ReturnType<typeof snapshot>) => void) => {
      publish(snapshot());
      await new Promise((r) => setTimeout(r, 5));
      controller.abort();
      expect(signal.aborted).toBe(true);
    });
    await runSharedLive({
      room,
      clientId: 'client-test',
      signal: controller.signal,
      runOwn,
      onSnapshot,
      onStatus: (s) => statuses.push(s),
      syncMs: 1,
      api,
    });
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect(calls.fetch).toBe(2);
    expect(runOwn).toHaveBeenCalledTimes(1);
    expect(calls.publish).toBe(1);
    expect(calls.leave).toBe(1);
    // The leader's heartbeats keep it leading meanwhile.
    expect(statuses.map((s) => s.mode).slice(0, 3)).toEqual(['follower', 'follower', 'leader']);
    expect(statuses.slice(3).every((s) => s.mode === 'leader')).toBe(true);
  });

  it('goes back to following when another page took the lease', async () => {
    const { api } = fakeApi(['leader', 'follower']);
    api.publish.mockResolvedValueOnce(false);
    const controller = new AbortController();
    let runs = 0;
    const runOwn = jest.fn(async (signal: AbortSignal, publish: (s: ReturnType<typeof snapshot>) => void) => {
      runs++;
      publish(snapshot());
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    });
    const onSnapshot = jest.fn(() => controller.abort());
    await runSharedLive({
      room,
      clientId: 'client-test',
      signal: controller.signal,
      runOwn,
      onSnapshot,
      onStatus: () => undefined,
      syncMs: 1,
      api,
    });
    expect(runs).toBe(1);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });
});
