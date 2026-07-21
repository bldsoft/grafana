import { useEffect } from 'react';

import { SelectableValue } from '@grafana/data';
import { locationService } from '@grafana/runtime';
import { Text } from '@grafana/ui';
import { contextSrv } from 'app/core/services/context_srv';
import { getUserOrganizations, setUserOrganization } from 'app/features/org/state/actions';
import { useDispatch, useSelector } from 'app/types/store';
import { UserOrg } from 'app/types/user';

import { Branding } from '../../Branding/Branding';

import { OrganizationSelect } from './OrganizationSelect';

export function OrganizationSwitcher() {
  const dispatch = useDispatch();
  const orgs = useSelector((state) => state.organization.userOrgs);
  const onSelectChange = (option: SelectableValue<UserOrg>) => {
    if (option.value) {
      setUserOrganization(option.value.orgId);
      locationService.push(`/?orgId=${option.value.orgId}`);
      // TODO how to reload the current page
      window.location.reload();
    }
  };
  useEffect(() => {
    if (
      contextSrv.isSignedIn &&
      !(contextSrv.user.authenticatedBy === 'apikey' || contextSrv.user.authenticatedBy === 'render')
    ) {
      dispatch(getUserOrganizations());
    }
  }, [dispatch]);

  if (orgs?.length <= 1) {
    // Analytix: with a single organization there is no switcher to show, so this
    // slot names the organization the user is in. Falls back to the product name
    // when the org name is unavailable (e.g. before bootData is populated).
    // No `truncate` - it sets width:100% and starves the breadcrumbs of space.
    return <Text>{contextSrv.user.orgName || Branding.AppTitle}</Text>;
  }

  return <OrganizationSelect orgs={orgs} onSelectChange={onSelectChange} />;
}
