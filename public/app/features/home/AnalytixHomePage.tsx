import { css } from '@emotion/css';
import { Suspense, lazy, useState } from 'react';
import { useAsync } from 'react-use';

import { GrafanaTheme2, PageLayoutType, locationUtil } from '@grafana/data';
import { getBackendSrv, locationService, reportInteraction } from '@grafana/runtime';
import { Spinner, useStyles2 } from '@grafana/ui';
import { AppChromeUpdate } from 'app/core/components/AppChrome/AppChromeUpdate';
import { Page } from 'app/core/components/Page/Page';
import { GenPanelButton } from 'app/features/dashboard-scene/ai-panel/GenPanelButton';
import { useAiInsiderAccess } from 'app/features/dashboard-scene/ai-panel/useAiInsiderAccess';
import { DashboardDTO, HomeDashboardRedirectDTO, isRedirectResponse } from 'app/types/dashboard';

import { DashboardCatalog } from './DashboardCatalog';
import { WelcomePanel } from './WelcomePanel';
import { AnalytixDashboard } from './useAnalytixDashboards';

// Analytix: loaded on demand so the home page does not pull the chat's heavy
// dependencies (scenes, markdown, SSE client) into its chunk until opened.
const GenPanelChat = lazy(() =>
  import('app/features/dashboard-scene/ai-panel/GenPanelChat').then((m) => ({ default: m.GenPanelChat }))
);

// Analytix: custom home page replacing the stock `welcome` + `dashlist` home
// dashboard. Rendered directly at "/" (see app/routes/routes.tsx) so the two
// approved design blocks are not constrained by the panel grid.
//
// The org/user "custom home dashboard" preference still wins: we ask
// /api/dashboards/home first and honour a redirect response exactly the way
// initDashboard.ts does, so tenants that set their own home dashboard keep it.
export function AnalytixHomePage() {
  // Analytix: the AI Insider chat opens as an overlay drawer covering the page
  // content up to the docked menu edge (see GenPanelChat).
  const [chatOpen, setChatOpen] = useState(false);
  // Analytix: the chat is rolled out per organisation — only users with access
  // to the AI Insider org get the button (and thus the chat) at all.
  const aiInsiderAllowed = useAiInsiderAccess();
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

  const handleChatToggle = () => {
    reportInteraction('analytix_home_ai_chat_toggled', { open: !chatOpen });
    setChatOpen((open) => !open);
  };

  return (
    // Analytix: Canvas layout drops the "Home" page header so the two design
    // blocks start at the top of the content area.
    <Page navId="home" layout={PageLayoutType.Canvas}>
      {/* Analytix: AI assistant button in the top-right header corner, same
          spot it used to occupy in the dashboard toolbar. `inlineActions`
          keeps it in the first header row at every screen width. */}
      {aiInsiderAllowed && <AppChromeUpdate inlineActions={<GenPanelButton onClick={handleChatToggle} />} />}
      <Page.Contents>
        {loading ? (
          <div className={styles.loading}>
            <Spinner />
          </div>
        ) : (
          <div className={styles.main}>
            <WelcomePanel onBrowse={handleBrowse} />
            <DashboardCatalog onOpen={handleOpen} />
          </div>
        )}
        {aiInsiderAllowed && chatOpen && (
          <Suspense fallback={null}>
            <GenPanelChat onClose={() => setChatOpen(false)} />
          </Suspense>
        )}
      </Page.Contents>
    </Page>
  );
}

export default AnalytixHomePage;

const getStyles = (theme: GrafanaTheme2) => ({
  main: css({
    display: 'grid',
    gap: 14,
    // Analytix: the welcome/catalog grids adapt via container queries (see
    // homeContainer in analytixTokens), so the container name must stay even
    // though the container now always spans the full content width.
    containerType: 'inline-size',
    containerName: 'analytix-home',
  }),
  loading: css({
    display: 'flex',
    justifyContent: 'center',
    padding: theme.spacing(8),
  }),
});
