import { css } from '@emotion/css';
import { Suspense, lazy, useState } from 'react';
import { useAsync } from 'react-use';

import { GrafanaTheme2, PageLayoutType, locationUtil } from '@grafana/data';
import { getBackendSrv, locationService, reportInteraction } from '@grafana/runtime';
import { Spinner, useStyles2 } from '@grafana/ui';
import { AppChromeUpdate } from 'app/core/components/AppChrome/AppChromeUpdate';
import { useChromeHeaderHeight } from 'app/core/components/AppChrome/TopBar/useChromeHeaderHeight';
import { Page } from 'app/core/components/Page/Page';
import { GenPanelButton } from 'app/features/dashboard-scene/ai-panel/GenPanelButton';
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
  // Analytix: the AI Insider chat docks into the page as the right half of a
  // split layout (the welcome block and the catalog adapt to the left half)
  // instead of covering the content with an overlay drawer.
  const [chatOpen, setChatOpen] = useState(false);
  const headerHeight = useChromeHeaderHeight();
  const styles = useStyles2(getStyles, headerHeight);

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
      <AppChromeUpdate inlineActions={<GenPanelButton onClick={handleChatToggle} />} />
      <Page.Contents>
        {loading ? (
          <div className={styles.loading}>
            <Spinner />
          </div>
        ) : (
          <div className={styles.split}>
            <div className={styles.main}>
              <WelcomePanel onBrowse={handleBrowse} />
              <DashboardCatalog onOpen={handleOpen} />
            </div>
            {chatOpen && (
              <div className={styles.chatPane}>
                <Suspense
                  fallback={
                    <div className={styles.loading}>
                      <Spinner />
                    </div>
                  }
                >
                  <GenPanelChat variant="docked" onClose={() => setChatOpen(false)} />
                </Suspense>
              </div>
            )}
          </div>
        )}
      </Page.Contents>
    </Page>
  );
}

export default AnalytixHomePage;

const getStyles = (theme: GrafanaTheme2, headerHeight = 0) => ({
  split: css({
    width: '100%',
    display: 'flex',
    alignItems: 'flex-start',
    gap: 14,

    [theme.breakpoints.down('lg')]: {
      flexDirection: 'column',
      alignItems: 'stretch',
    },
  }),
  main: css({
    flex: '1 1 50%',
    minWidth: 0,
    display: 'grid',
    gap: 14,
    // Analytix: the welcome/catalog grids adapt via container queries, so
    // they reflow when the docked chat halves the available width (viewport
    // breakpoints would not fire in that case).
    containerType: 'inline-size',
    containerName: 'analytix-home',
    // Analytix: cards and the welcome block use local zIndex:1 layers (e.g.
    // the favorite stars); isolate them so they cannot paint over the sticky
    // chat pane, which has no z-index of its own.
    isolation: 'isolate',
  }),
  // Analytix: the docked chat takes the right half of the screen and stays
  // pinned to the viewport (its message list scrolls internally) while the
  // dashboards half scrolls as usual. Offsets: sticky header + canvas padding.
  chatPane: css({
    flex: '1 1 50%',
    minWidth: 0,
    position: 'sticky',
    top: headerHeight + 16,
    height: `calc(100vh - ${headerHeight + 32}px)`,

    [theme.breakpoints.down('lg')]: {
      // Stacked layout: the chat opens above the dashboards at a fixed height.
      position: 'static',
      order: -1,
      height: '70vh',
    },
  }),
  loading: css({
    display: 'flex',
    justifyContent: 'center',
    padding: theme.spacing(8),
  }),
});
