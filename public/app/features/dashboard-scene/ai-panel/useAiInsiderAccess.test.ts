import { renderHook, waitFor } from '@testing-library/react';

import { contextSrv } from 'app/core/services/context_srv';

import { AI_INSIDER_ORG_ID, useAiInsiderAccess } from './useAiInsiderAccess';

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
    contextSrv.user.orgId = 2;
    contextSrv.isSignedIn = true;
  });

  it('allows immediately when the active org is the AI Insider org, without asking the API', async () => {
    contextSrv.user.orgId = AI_INSIDER_ORG_ID;
    const { result } = renderHook(() => useAiInsiderAccess());
    expect(result.current).toBe(true);
    // Let the useAsync effect settle (it resolves without a network call).
    await waitFor(() => expect(result.current).toBe(true));
    expect(getMock).not.toHaveBeenCalled();
  });

  it('allows a member of the AI Insider org browsing another org', async () => {
    getMock.mockResolvedValue([
      { orgId: 2, name: 'Other', role: 'Viewer' },
      { orgId: AI_INSIDER_ORG_ID, name: 'Main', role: 'Viewer' },
    ]);
    const { result } = renderHook(() => useAiInsiderAccess());
    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/api/user/orgs', undefined, undefined, { showErrorAlert: false });
  });

  it('denies a user without membership in the AI Insider org', async () => {
    getMock.mockResolvedValue([{ orgId: 2, name: 'Other', role: 'Viewer' }]);
    const { result } = renderHook(() => useAiInsiderAccess());
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('fails closed when the membership lookup errors', async () => {
    getMock.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useAiInsiderAccess());
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('denies anonymous sessions without asking the API', async () => {
    contextSrv.isSignedIn = false;
    const { result } = renderHook(() => useAiInsiderAccess());
    // Give the async effect a tick to (not) fire.
    await waitFor(() => expect(result.current).toBe(false));
    expect(getMock).not.toHaveBeenCalled();
  });
});
