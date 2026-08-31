// Analytix: access gate for the AI Insider chat entry points. The assistant
// is rolled out per user via a Grafana team: the chat button shows only for
// members of the rollout team inside the primary Analytix organisation, so
// access is managed by adding/removing people from that team — no deploys.

import { useAsync } from 'react-use';

import { getBackendSrv } from '@grafana/runtime';
import { contextSrv } from 'app/core/services/context_srv';

/** The organisation whose members may use the AI Insider chat. */
export const AI_INSIDER_ORG_ID = 1;

/**
 * UIDs of the rollout teams (one per environment — the same build serves
 * both). A team's UID is visible in its URL: /org/teams/edit/<uid>. Teams are
 * matched by UID, not by numeric id: the numeric id is an auto-increment
 * database key, so the same team has a different number on every instance.
 */
export const AI_INSIDER_TEAM_UIDS = ['cfwubwdg1oxdsf', 'afw9ckp7tmigwa'];

/** The subset of the /api/user/teams TeamDTO this gate reads. */
interface UserTeam {
  uid?: string;
}

/**
 * True when the signed-in user is browsing the AI Insider organisation
 * ({@link AI_INSIDER_ORG_ID}) AND belongs to one of the rollout teams
 * ({@link AI_INSIDER_TEAM_UIDS}). Team membership is org-scoped and
 * /api/user/teams answers for the active org only, so the gate requires the
 * user to actually be in the org, not merely a member of it. False while the
 * lookup is in flight and on any lookup error (fail closed: the button simply
 * never appears rather than appearing and then breaking).
 */
export function useAiInsiderAccess(): boolean {
  const inTargetOrg = contextSrv.isSignedIn && contextSrv.user.orgId === AI_INSIDER_ORG_ID;

  const { value: inTeam } = useAsync(async () => {
    if (!inTargetOrg) {
      return false;
    }
    const teams = await getBackendSrv().get<UserTeam[]>('/api/user/teams', undefined, undefined, {
      showErrorAlert: false,
    });
    return teams.some((team) => typeof team.uid === 'string' && AI_INSIDER_TEAM_UIDS.includes(team.uid));
  }, [inTargetOrg]);

  return inTargetOrg && Boolean(inTeam);
}
