import { renderHook, waitFor } from '@testing-library/react';

import { contextSrv } from 'app/core/services/context_srv';

import { AI_INSIDER_ORG_ID, AI_INSIDER_TEAM_UIDS, useAiInsiderAccess } from './useAiInsiderAccess';

const getMock = jest.fn();

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getBackendSrv: () => ({ get: getMock }),
}));

jest.mock('app/core/services/context_srv', () => ({
  contextSrv: {
    user: { orgId: 0 },
    isSignedIn: true,
  },
}));

describe('useAiInsiderAccess', () => {
  beforeEach(() => {
    getMock.mockReset();
    contextSrv.user.orgId = AI_INSIDER_ORG_ID;
    contextSrv.isSignedIn = true;
  });

  it('allows a rollout-team member browsing the AI Insider org', async () => {
    getMock.mockResolvedValue([{ uid: 'other-team' }, { uid: AI_INSIDER_TEAM_UIDS[0] }]);
    const { result } = renderHook(() => useAiInsiderAccess());
    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/api/user/teams', undefined, undefined, { showErrorAlert: false });
  });

  it('accepts any of the per-environment team UIDs', async () => {
    getMock.mockResolvedValue([{ uid: AI_INSIDER_TEAM_UIDS[1] }]);
    const { result } = renderHook(() => useAiInsiderAccess());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('denies an org member outside the rollout teams', async () => {
    getMock.mockResolvedValue([{ uid: 'other-team' }]);
    const { result } = renderHook(() => useAiInsiderAccess());
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('denies a user browsing another org without asking the API', async () => {
    contextSrv.user.orgId = 2;
    const { result } = renderHook(() => useAiInsiderAccess());
    // Give the async effect a tick to (not) fire.
    await waitFor(() => expect(result.current).toBe(false));
    expect(getMock).not.toHaveBeenCalled();
  });

  it('fails closed when the team lookup errors', async () => {
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
