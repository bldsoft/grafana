import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useParams } from 'react-router-dom-v5-compat';
import { useAsyncFn } from 'react-use';

import { NavModelItem, OrgRole } from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import { Field, Input, Button, Legend, Alert, Stack } from '@grafana/ui';
import { Page } from 'app/core/components/Page/Page';
import { contextSrv } from 'app/core/services/context_srv';
import { AccessControlAction } from 'app/types/accessControl';
import { OrgUser } from 'app/types/user';

import { OrgUsersTable } from './Users/OrgUsersTable';
import { getOrg, getOrgUsers, getUsersRoles, removeOrgUser, updateOrg, updateOrgUserRole } from './api';

interface OrgSettingsDTO {
  orgName: string;
  providerIds: string;
  externalServicesTeamId: string;
}

// "*" = all providers; empty = no data access; otherwise a comma-separated id list
const PROVIDER_IDS_PATTERN = /^\s*(\*|[A-Za-z0-9_-]+(\s*,\s*[A-Za-z0-9_-]+)*)?\s*$/;
// A single team UID or numeric id; empty = external services are off for the org
const TEAM_ID_PATTERN = /^\s*[A-Za-z0-9_-]*\s*$/;

const AdminEditOrgPage = () => {
  const { id = '' } = useParams();
  const orgId = parseInt(id, 10);
  const canWriteOrg = contextSrv.hasPermission(AccessControlAction.OrgsWrite);
  const canReadUsers = contextSrv.hasPermission(AccessControlAction.OrgUsersRead);
  // The provider id scope and the external services team gate access; the API
  // only lets server admins set them, so an org admin renaming the org must
  // not send them at all (the API would answer 403 even for unchanged values).
  const canWriteAccessFields = canWriteOrg && contextSrv.isGrafanaAdmin;

  const [users, setUsers] = useState<OrgUser[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [orgState, fetchOrg] = useAsyncFn(() => getOrg(orgId), []);
  const {
    handleSubmit,
    register,
    formState: { errors },
  } = useForm<OrgSettingsDTO>();
  const [, fetchOrgUsers] = useAsyncFn(async (page) => {
    const result = await getOrgUsers(orgId, page);

    if (contextSrv.licensedAccessControlEnabled()) {
      await getUsersRoles(orgId, result.orgUsers);
    }

    const totalPages = result?.perPage !== 0 ? Math.ceil(result.totalCount / result.perPage) : 0;
    setTotalPages(totalPages);
    setUsers(result.orgUsers);
    return result.orgUsers;
  }, []);

  useEffect(() => {
    fetchOrg();
    fetchOrgUsers(page);
  }, [fetchOrg, fetchOrgUsers, page]);

  const onUpdateOrg = async ({ orgName, providerIds, externalServicesTeamId }: OrgSettingsDTO) => {
    await updateOrg(orgId, {
      name: orgName,
      ...(canWriteAccessFields
        ? { providerIds: providerIds ?? '', externalServicesTeamId: externalServicesTeamId ?? '' }
        : {}),
    });
    fetchOrg();
  };

  const renderMissingPermissionMessage = () => (
    <Alert
      severity="info"
      title={t('admin.admin-edit-org-page.render-missing-permission-message.title-access-denied', 'Access denied')}
    >
      <Trans i18nKey="admin.edit-org.access-denied">
        You do not have permission to see users in this organization. To update this organization, contact your server
        administrator.
      </Trans>
    </Alert>
  );

  const onPageChange = (toPage: number) => {
    setPage(toPage);
  };

  const onRemoveUser = async (orgUser: OrgUser) => {
    await removeOrgUser(orgUser, orgId);
    fetchOrgUsers(page);
  };

  const onRoleChange = async (role: OrgRole, orgUser: OrgUser) => {
    await updateOrgUserRole({ ...orgUser, role }, orgId);
    fetchOrgUsers(page);
  };

  const pageNav: NavModelItem = {
    text: orgState?.value?.name ?? '',
    icon: 'shield',
    subTitle: t(
      'admin.admin-edit-org-page.page-nav.subTitle.manage-settings-roles-organization',
      'Manage settings and user roles for an organization.'
    ),
  };

  return (
    <Page navId="global-orgs" pageNav={pageNav} subTitle="Manage settings for this specific org.">
      <Page.Contents>
        <>
          <Legend>
            <Trans i18nKey="admin.edit-org.heading">Edit Organization</Trans>
          </Legend>
          {orgState.value && (
            <form onSubmit={handleSubmit(onUpdateOrg)} style={{ maxWidth: '600px' }}>
              <Stack direction="column" gap={2}>
                <Field
                  label={t('admin.admin-edit-org-page.label-name', 'Name')}
                  invalid={!!errors.orgName}
                  error="Name is required"
                  disabled={!canWriteOrg}
                  noMargin
                >
                  <Input
                    {...register('orgName', { required: true })}
                    id="org-name-input"
                    defaultValue={orgState.value.name}
                  />
                </Field>
                <Field
                  label={t('admin.admin-edit-org-page.label-provider-ids', 'Provider IDs (PID)')}
                  description={t(
                    'admin.admin-edit-org-page.description-provider-ids',
                    'Comma-separated provider ids this organization is allowed to query, e.g. 111,222. Use * for all providers. Empty means no data access.'
                  )}
                  invalid={!!errors.providerIds}
                  error={t(
                    'admin.admin-edit-org-page.error-provider-ids',
                    'Must be * or a comma-separated list of ids (letters, digits, "-", "_")'
                  )}
                  disabled={!canWriteAccessFields}
                  noMargin
                >
                  <Input
                    {...register('providerIds', { pattern: PROVIDER_IDS_PATTERN })}
                    id="org-provider-ids-input"
                    placeholder={t('admin.admin-edit-org-page.placeholder-provider-ids', '111,222')}
                    defaultValue={orgState.value.providerIds ?? ''}
                  />
                </Field>
                <Field
                  label={t('admin.admin-edit-org-page.label-external-services-team', 'External services access team')}
                  description={t(
                    'admin.admin-edit-org-page.description-external-services-team',
                    'UID of the team whose members may use external services such as AI Insider (the UID is in the team URL: /org/teams/edit/<uid>). Empty means the services are off for this organization.'
                  )}
                  invalid={!!errors.externalServicesTeamId}
                  error={t(
                    'admin.admin-edit-org-page.error-external-services-team',
                    'Must be a single team UID or numeric id (letters, digits, "-", "_")'
                  )}
                  disabled={!canWriteAccessFields}
                  noMargin
                >
                  <Input
                    {...register('externalServicesTeamId', { pattern: TEAM_ID_PATTERN })}
                    id="org-external-services-team-input"
                    placeholder={t('admin.admin-edit-org-page.placeholder-external-services-team', 'cfwubwdg1oxdsf')}
                    defaultValue={orgState.value.externalServicesTeamId ?? ''}
                  />
                </Field>
                <div>
                  <Button type="submit" disabled={!canWriteOrg}>
                    <Trans i18nKey="admin.edit-org.update-button">Update</Trans>
                  </Button>
                </div>
              </Stack>
            </form>
          )}

          <div style={{ marginTop: '20px' }}>
            <Legend>
              <Trans i18nKey="admin.edit-org.users-heading">Organization users</Trans>
            </Legend>
            {!canReadUsers && renderMissingPermissionMessage()}
            {canReadUsers && !!users.length && (
              <OrgUsersTable
                users={users}
                orgId={orgId}
                onRoleChange={onRoleChange}
                onRemoveUser={onRemoveUser}
                changePage={onPageChange}
                page={page}
                totalPages={totalPages}
              />
            )}
          </div>
        </>
      </Page.Contents>
    </Page>
  );
};

export default AdminEditOrgPage;
