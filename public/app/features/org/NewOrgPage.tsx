import { connect, ConnectedProps } from 'react-redux';

import { NavModelItem } from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import { Button, Input, Field, FieldSet, Stack } from '@grafana/ui';
import { Form } from 'app/core/components/Form/Form';
import { Page } from 'app/core/components/Page/Page';
import { getConfig } from 'app/core/config';
import { contextSrv } from 'app/core/services/context_srv';

import { createOrganization } from './state/actions';

const mapDispatchToProps = {
  createOrganization,
};

const connector = connect(undefined, mapDispatchToProps);

type Props = ConnectedProps<typeof connector>;

interface CreateOrgFormDTO {
  name: string;
  providerIds: string;
}

const PROVIDER_IDS_PATTERN = /^\s*\d+(\s*,\s*\d+)*\s*$|^\s*$/;

const pageNav: NavModelItem = {
  icon: 'building',
  id: 'org-new',
  text: 'New organization',
};

export const NewOrgPage = ({ createOrganization }: Props) => {
  const createOrg = async (newOrg: CreateOrgFormDTO) => {
    await createOrganization({ name: newOrg.name, providerIds: newOrg.providerIds ?? '' });
    window.location.href = getConfig().appSubUrl + '/org';
  };

  return (
    <Page navId="global-orgs" pageNav={pageNav}>
      <Page.Contents>
        <p className="muted">
          <Trans i18nKey="org.new-org-page.description">
            Each organization contains their own dashboards, data sources, and configuration, which cannot be shared
            shared between organizations. While users might belong to more than one organization, multiple organizations
            are most frequently used in multi-tenant deployments.
          </Trans>
        </p>

        <Form<CreateOrgFormDTO> onSubmit={createOrg}>
          {({ register, errors }) => {
            return (
              <>
                <FieldSet>
                  <Stack direction="column" gap={2}>
                    <Field
                      label={t('org.new-org-page.label-organization-name', 'Organization name')}
                      invalid={!!errors.name}
                      error={errors.name && errors.name.message}
                      noMargin
                    >
                      <Input
                        placeholder={t('org.new-org-page.placeholder-org-name', 'Org name')}
                        {...register('name', {
                          required: 'Organization name is required',
                        })}
                      />
                    </Field>
                    {/* The provider id scope gates data access; the API only lets server admins set it */}
                    {contextSrv.isGrafanaAdmin && (
                      <Field
                        label={t('org.new-org-page.label-provider-ids', 'Provider IDs (PID)')}
                        description={t(
                          'org.new-org-page.description-provider-ids',
                          'Comma-separated provider ids this organization is allowed to query, e.g. 111,222. Leave empty for no restriction.'
                        )}
                        invalid={!!errors.providerIds}
                        error={errors.providerIds && errors.providerIds.message}
                        noMargin
                      >
                        <Input
                          placeholder={t('org.new-org-page.placeholder-provider-ids', '111,222')}
                          {...register('providerIds', {
                            pattern: {
                              value: PROVIDER_IDS_PATTERN,
                              message: t(
                                'org.new-org-page.error-provider-ids',
                                'Must be a comma-separated list of numeric ids'
                              ),
                            },
                          })}
                        />
                      </Field>
                    )}
                  </Stack>
                </FieldSet>
                <Button type="submit">
                  <Trans i18nKey="org.new-org-page.create">Create</Trans>
                </Button>
              </>
            );
          }}
        </Form>
      </Page.Contents>
    </Page>
  );
};

export default connector(NewOrgPage);
