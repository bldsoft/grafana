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
}

const PROVIDER_IDS_PATTERN = /^\s*\d+(\s*,\s*\d+)*\s*$|^\s*$/;

const AdminEditOrgPage = () => {
  const { id = '' } = useParams();
  const orgId = parseInt(id, 10);
  const canWriteOrg = contextSrv.hasPermission(AccessControlAction.OrgsWrite);
  const canReadUsers = contextSrv.hasPermission(AccessControlAction.OrgUsersRead);

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

  const onUpdateOrg = async ({ orgName, providerIds }: OrgSettingsDTO) => {
    await updateOrg(orgId, { name: orgName, providerIds: providerIds ?? '' });
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
                    'Comma-separated provider ids this organization is allowed to query, e.g. 111,222. Leave empty for no restriction.'
                  )}
                  invalid={!!errors.providerIds}
                  error={t(
                    'admin.admin-edit-org-page.error-provider-ids',
                    'Must be a comma-separated list of numeric ids'
                  )}
                  disabled={!canWriteOrg}
                  noMargin
                >
                  <Input
                    {...register('providerIds', { pattern: PROVIDER_IDS_PATTERN })}
                    id="org-provider-ids-input"
                    placeholder={t('admin.admin-edit-org-page.placeholder-provider-ids', '111,222')}
                    defaultValue={orgState.value.providerIds ?? ''}
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
