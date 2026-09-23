import { renderHook, waitFor } from '@testing-library/react';

import { contextSrv } from 'app/core/services/context_srv';

import { useAiInsiderAccess } from './useAiInsiderAccess';

const getMock = jest.fn();

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getBackendSrv: () => ({ get: getMock }),
}));

jest.mock('app/core/services/context_srv', () => ({
  contextSrv: {
    user: { orgId: 1 },
    isSignedIn: true,
  },
}));

const TEAM_UID = 'cfwubwdg1oxdsf';
const OPTS = { showErrorAlert: false };

/** Mock /api/org and /api/user/teams by path. */
function mockApi(org: unknown, teams: unknown) {
  getMock.mockImplementation((url: string) => {
    if (url === '/api/org') {
      return Promise.resolve(org);
    }
    if (url === '/api/user/teams') {
      return Promise.resolve(teams);
    }
    return Promise.reject(new Error(`unexpected url ${url}`));
  });
}

describe('useAiInsiderAccess', () => {
  beforeEach(() => {
    getMock.mockReset();
    contextSrv.user.orgId = 1;
    contextSrv.isSignedIn = true;
  });

  it('allows a member of the org external services team', async () => {
    mockApi({ id: 1, externalServicesTeamId: TEAM_UID }, [
      { id: 3, uid: 'other-team' },
      { id: 6, uid: TEAM_UID },
    ]);
    const { result } = renderHook(() => useAiInsiderAccess());
    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/api/org', undefined, undefined, OPTS);
    expect(getMock).toHaveBeenCalledWith('/api/user/teams', undefined, undefined, OPTS);
  });

  it('matches the team by numeric id as well', async () => {
    mockApi({ id: 1, externalServicesTeamId: '6' }, [{ id: 6, uid: TEAM_UID }]);
    const { result } = renderHook(() => useAiInsiderAccess());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('tolerates whitespace around the stored team id', async () => {
    mockApi({ id: 1, externalServicesTeamId: ` ${TEAM_UID} ` }, [{ id: 6, uid: TEAM_UID }]);
    const { result } = renderHook(() => useAiInsiderAccess());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('never matches a team with missing ids against the literal "undefined"', async () => {
    mockApi({ id: 1, externalServicesTeamId: 'undefined' }, [{ name: 'no-ids' }]);
    const { result } = renderHook(() => useAiInsiderAccess());
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/api/user/teams', undefined, undefined, OPTS));
    expect(result.current).toBe(false);
  });

  it('denies an org member outside the external services team', async () => {
    mockApi({ id: 1, externalServicesTeamId: TEAM_UID }, [{ id: 3, uid: 'other-team' }]);
    const { result } = renderHook(() => useAiInsiderAccess());
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/api/user/teams', undefined, undefined, OPTS));
    expect(result.current).toBe(false);
  });

  it('denies everyone in an org without a team, without asking for teams', async () => {
    mockApi({ id: 1, externalServicesTeamId: '' }, [{ id: 6, uid: TEAM_UID }]);
    const { result } = renderHook(() => useAiInsiderAccess());
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/api/org', undefined, undefined, OPTS));
    await waitFor(() => expect(result.current).toBe(false));
    expect(getMock).not.toHaveBeenCalledWith('/api/user/teams', undefined, undefined, OPTS);
  });

  it('denies when the org response carries no attribute at all (older backend)', async () => {
    mockApi({ id: 1, name: 'Main' }, [{ id: 6, uid: TEAM_UID }]);
    const { result } = renderHook(() => useAiInsiderAccess());
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/api/org', undefined, undefined, OPTS));
    expect(result.current).toBe(false);
  });

  it('fails closed when a lookup errors', async () => {
    getMock.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useAiInsiderAccess());
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('denies anonymous sessions without asking the API', async () => {
    contextSrv.isSignedIn = false;
    const { result } = renderHook(() => useAiInsiderAccess());
    await waitFor(() => expect(result.current).toBe(false));
    expect(getMock).not.toHaveBeenCalled();
  });
});
