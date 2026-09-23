// Analytix: access gate for the AI Insider chat entry points. The assistant
// is rolled out per organisation via a Grafana team: a server admin assigns
// the organisation an "external services access team" (org attribute
// externalServicesTeamId, maintained in the org admin UI), and the chat button
// shows only for members of that team. Access is managed by editing the org
// attribute and the team's membership — no deploys, no hard-coded ids.

import { useAsync } from 'react-use';

import { getBackendSrv } from '@grafana/runtime';
import { contextSrv } from 'app/core/services/context_srv';

/** The subset of the /api/org OrgDetailsDTO this gate reads. */
interface CurrentOrg {
  externalServicesTeamId?: string;
}

/** The subset of the /api/user/teams TeamDTO this gate reads. */
interface UserTeam {
  id?: number;
  uid?: string;
}

/**
 * True when the signed-in user's ACTIVE organisation has an external services
 * team assigned AND the user belongs to it. Team membership is org-scoped and
 * /api/user/teams answers for the active org only, so the gate follows the
 * org the user is switched to. The team is matched by UID (what the admin UI
 * asks for); a numeric team id is accepted too. False while the lookup is in
 * flight and on any lookup error (fail closed: the button simply never
 * appears rather than appearing and then breaking). The backend applies the
 * same gate on every request, so this is a UX gate, not the security boundary.
 */
export function useAiInsiderAccess(): boolean {
  const signedIn = contextSrv.isSignedIn;
  const orgId = contextSrv.user.orgId;

  const { value: allowed } = useAsync(async () => {
    if (!signedIn) {
      return false;
    }
    const org = await getBackendSrv().get<CurrentOrg>('/api/org', undefined, undefined, {
      showErrorAlert: false,
    });
    const teamId = typeof org?.externalServicesTeamId === 'string' ? org.externalServicesTeamId.trim() : '';
    if (!teamId) {
      return false;
    }
    const teams = await getBackendSrv().get<UserTeam[]>('/api/user/teams', undefined, undefined, {
      showErrorAlert: false,
    });
    // Compare only present fields: a team without an id must never match the
    // literal "undefined"/"null".
    return teams.some(
      (team) => (team.uid != null && team.uid === teamId) || (team.id != null && String(team.id) === teamId)
    );
  }, [signedIn, orgId]);

  return Boolean(allowed);
}
