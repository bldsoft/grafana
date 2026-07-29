import { css } from '@emotion/css';
import { useAsync } from 'react-use';

import { GrafanaTheme2, PageLayoutType, locationUtil } from '@grafana/data';
import { getBackendSrv, locationService, reportInteraction } from '@grafana/runtime';
import { Spinner, useStyles2 } from '@grafana/ui';
import { AppChromeUpdate } from 'app/core/components/AppChrome/AppChromeUpdate';
import { Page } from 'app/core/components/Page/Page';
import { GenPanelButton } from 'app/features/dashboard-scene/ai-panel/GenPanelButton';
import { DashboardDTO, HomeDashboardRedirectDTO, isRedirectResponse } from 'app/types/dashboard';

import { DashboardCatalog } from './DashboardCatalog';
import { WelcomePanel } from './WelcomePanel';
import { AnalytixDashboard } from './useAnalytixDashboards';

// Analytix: custom home page replacing the stock `welcome` + `dashlist` home
// dashboard. Rendered directly at "/" (see app/routes/routes.tsx) so the two
// approved design blocks are not constrained by the panel grid.
//
// The org/user "custom home dashboard" preference still wins: we ask
// /api/dashboards/home first and honour a redirect response exactly the way
// initDashboard.ts does, so tenants that set their own home dashboard keep it.
export function AnalytixHomePage() {
  const styles = useStyles2(getStyles);

  const { loading } = useAsync(async () => {
    const dto = await getBackendSrv().get<DashboardDTO | HomeDashboardRedirectDTO>('/api/dashboards/home');

    if (isRedirectResponse(dto)) {
      locationService.replace(locationUtil.stripBaseFromUrl(dto.redirectUri));
    }
  }, []);

  const handleBrowse = () => {
    reportInteraction('analytix_home_welcome_browse_clicked');
    // Analytix: the CTA routes to the dashboards catalog rather than scrolling
    // to the section below it.
    locationService.push('/dashboards');
  };

  const handleOpen = (dashboard: AnalytixDashboard) => {
    reportInteraction('analytix_home_dashboard_opened');
    locationService.push(locationUtil.stripBaseFromUrl(dashboard.url));
  };

  return (
    // Analytix: Canvas layout drops the "Home" page header so the two design
    // blocks start at the top of the content area.
    <Page navId="home" layout={PageLayoutType.Canvas}>
      {/* Analytix: AI assistant button in the top-right header corner, same
          spot it used to occupy in the dashboard toolbar. `inlineActions`
          keeps it in the first header row at every screen width. */}
      <AppChromeUpdate inlineActions={<GenPanelButton />} />
      <Page.Contents>
        {loading ? (
          <div className={styles.loading}>
            <Spinner />
          </div>
        ) : (
          <div className={styles.layout}>
            <WelcomePanel onBrowse={handleBrowse} />
            <DashboardCatalog onOpen={handleOpen} />
          </div>
        )}
      </Page.Contents>
    </Page>
  );
}

export default AnalytixHomePage;

const getStyles = (theme: GrafanaTheme2) => ({
  layout: css({
    width: '100%',
    display: 'grid',
    gap: 14,
  }),
  loading: css({
    display: 'flex',
    justifyContent: 'center',
    padding: theme.spacing(8),
  }),
});
