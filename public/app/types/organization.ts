import { UserOrg } from 'app/types/user';

export interface Organization {
  name: string;
  id: number;
  // Comma-separated provider ids (PID) the organization is allowed to query
  providerIds?: string;
}

export interface OrganizationState {
  organization: Organization;
  userOrgs: UserOrg[];
}
