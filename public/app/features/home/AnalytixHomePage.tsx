import { css } from '@emotion/css';
import { useRef } from 'react';
import { useAsync } from 'react-use';

import { GrafanaTheme2, locationUtil } from '@grafana/data';
import { getBackendSrv, locationService, reportInteraction } from '@grafana/runtime';
import { Spinner, useStyles2 } from '@grafana/ui';
import { Page } from 'app/core/components/Page/Page';
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
  const catalogRef = useRef<HTMLElement>(null);

  const { loading } = useAsync(async () => {
    const dto = await getBackendSrv().get<DashboardDTO | HomeDashboardRedirectDTO>('/api/dashboards/home');

    if (isRedirectResponse(dto)) {
      locationService.replace(locationUtil.stripBaseFromUrl(dto.redirectUri));
    }
  }, []);

  const handleBrowse = () => {
    reportInteraction('analytix_home_welcome_browse_clicked');
    // Analytix: the design spec requires the reduced-motion preference to
    // disable smooth scrolling.
    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    catalogRef.current?.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'start' });
  };

  const handleOpen = (dashboard: AnalytixDashboard) => {
    reportInteraction('analytix_home_dashboard_opened');
    locationService.push(locationUtil.stripBaseFromUrl(dashboard.url));
  };

  return (
    <Page navId="home">
      <Page.Contents>
        {loading ? (
          <div className={styles.loading}>
            <Spinner />
          </div>
        ) : (
          <div className={styles.layout}>
            <WelcomePanel onBrowse={handleBrowse} />
            <DashboardCatalog ref={catalogRef} onOpen={handleOpen} />
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
