import { UserOrg } from 'app/types/user';

export interface Organization {
  name: string;
  id: number;
  // Comma-separated provider ids (PID) the organization is allowed to query
  providerIds?: string;
  // UID (or numeric id) of the team whose members may use external services
  // such as AI Insider; empty = the services are off for this organization
  externalServicesTeamId?: string;
}

export interface OrganizationState {
  organization: Organization;
  userOrgs: UserOrg[];
}
