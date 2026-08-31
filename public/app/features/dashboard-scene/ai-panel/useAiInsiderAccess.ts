// Analytix: access gate for the AI Insider chat entry points. The assistant
// is rolled out only to members of the primary Analytix organisation, so the
// chat button stays hidden for everyone else.

import { useAsync } from 'react-use';

import { getBackendSrv } from '@grafana/runtime';
import { contextSrv } from 'app/core/services/context_srv';
import { UserOrg } from 'app/types/user';

/** The organisation whose members may use the AI Insider chat. */
export const AI_INSIDER_ORG_ID = 1;

/**
 * True when the signed-in user has access to the AI Insider organisation
 * ({@link AI_INSIDER_ORG_ID}) — either it is their active org, or they are a
 * member of it while browsing another org. False while the membership lookup
 * is still in flight and on any lookup error (fail closed: the button simply
 * never appears rather than appearing and then breaking).
 */
export function useAiInsiderAccess(): boolean {
  const activeOrgMatches = contextSrv.user.orgId === AI_INSIDER_ORG_ID;

  const { value: isMember } = useAsync(async () => {
    // Already decided without a request, or an anonymous session that cannot
    // ask /api/user/orgs at all.
    if (activeOrgMatches || !contextSrv.isSignedIn) {
      return false;
    }
    const orgs = await getBackendSrv().get<UserOrg[]>('/api/user/orgs', undefined, undefined, {
      showErrorAlert: false,
    });
    return orgs.some((org) => org.orgId === AI_INSIDER_ORG_ID);
  }, [activeOrgMatches]);

  return activeOrgMatches || Boolean(isMember);
}
