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
  externalServicesTeamId: string;
}

// "*" = all providers; empty = no data access; otherwise a comma-separated id list
const PROVIDER_IDS_PATTERN = /^\s*(\*|[A-Za-z0-9_-]+(\s*,\s*[A-Za-z0-9_-]+)*)?\s*$/;
// A single team UID or numeric id; empty = external services are off for the org
const TEAM_ID_PATTERN = /^\s*[A-Za-z0-9_-]*\s*$/;

const pageNav: NavModelItem = {
  icon: 'building',
  id: 'org-new',
  text: 'New organization',
};

export const NewOrgPage = ({ createOrganization }: Props) => {
  const createOrg = async (newOrg: CreateOrgFormDTO) => {
    await createOrganization({
      name: newOrg.name,
      providerIds: newOrg.providerIds ?? '',
      externalServicesTeamId: newOrg.externalServicesTeamId ?? '',
    });
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
                    {/* The provider id scope and the external services team gate access; the API only lets server admins set them */}
                    {contextSrv.isGrafanaAdmin && (
                      <Field
                        label={t('org.new-org-page.label-provider-ids', 'Provider IDs (PID)')}
                        description={t(
                          'org.new-org-page.description-provider-ids',
                          'Comma-separated provider ids this organization is allowed to query, e.g. 111,222. Use * for all providers. Empty means no data access.'
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
                                'Must be * or a comma-separated list of ids (letters, digits, "-", "_")'
                              ),
                            },
                          })}
                        />
                      </Field>
                    )}
                    {contextSrv.isGrafanaAdmin && (
                      <Field
                        label={t('org.new-org-page.label-external-services-team', 'External services access team')}
                        description={t(
                          'org.new-org-page.description-external-services-team',
                          'UID of the team whose members may use external services such as AI Insider (the UID is in the team URL: /org/teams/edit/<uid>). Empty means the services are off for this organization.'
                        )}
                        invalid={!!errors.externalServicesTeamId}
                        error={errors.externalServicesTeamId && errors.externalServicesTeamId.message}
                        noMargin
                      >
                        <Input
                          placeholder={t('org.new-org-page.placeholder-external-services-team', 'cfwubwdg1oxdsf')}
                          {...register('externalServicesTeamId', {
                            pattern: {
                              value: TEAM_ID_PATTERN,
                              message: t(
                                'org.new-org-page.error-external-services-team',
                                'Must be a single team UID or numeric id (letters, digits, "-", "_")'
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
