import { css, cx } from '@emotion/css';
import classNames from 'classnames';
import { Resizable } from 're-resizable';
import { PropsWithChildren, useEffect } from 'react';

import { GrafanaTheme2, store } from '@grafana/data';
import { Trans } from '@grafana/i18n';
import { locationSearchToObject, locationService, useScopes } from '@grafana/runtime';
import { ErrorBoundaryAlert, floatingUtils, getDragStyles, LinkButton, useStyles2 } from '@grafana/ui';
import { useGrafana } from 'app/core/context/GrafanaContext';
import { useMediaQueryMinWidth } from 'app/core/hooks/useMediaQueryMinWidth';
import { CommandPalette } from 'app/features/commandPalette/CommandPalette';
import { ScopesDashboards } from 'app/features/scopes/dashboards/ScopesDashboards';

import { AppChromeMenu } from './AppChromeMenu';
import { AppChromeService, DOCKED_MENU_OPEN_LOCAL_STORAGE_KEY } from './AppChromeService';
import {
  ExtensionSidebar,
  MAX_EXTENSION_SIDEBAR_WIDTH,
  MIN_EXTENSION_SIDEBAR_WIDTH,
} from './ExtensionSidebar/ExtensionSidebar';
import { useExtensionSidebarContext } from './ExtensionSidebar/ExtensionSidebarProvider';
import { MegaMenu } from './MegaMenu/MegaMenu';
import { useMegaMenuFocusHelper } from './MegaMenu/utils';
import { ReturnToPrevious } from './ReturnToPrevious/ReturnToPrevious';
import { SingleTopBar } from './TopBar/SingleTopBar';
import { useChromeHeaderLevels } from './TopBar/useChromeHeaderHeight';

export interface Props extends PropsWithChildren<{}> {}

export function AppChrome({ children }: Props) {
  const { chrome } = useGrafana();
  const {
    isOpen: isExtensionSidebarOpen,
    extensionSidebarWidth,
    setExtensionSidebarWidth,
  } = useExtensionSidebarContext();
  const state = chrome.useState();
  const scopes = useScopes();

  const headerLevels = useChromeHeaderLevels();
  const styles = useStyles2(getStyles, state.megaMenuOpen);
  const contentSizeStyles = useStyles2(getContentSizeStyles, extensionSidebarWidth);
  const dragStyles = useStyles2(getDragStyles);

  useResponsiveDockedMegaMenu(chrome);
  useMegaMenuFocusHelper(state.megaMenuOpen, state.megaMenuDocked);

  const contentClass = cx({
    [styles.content]: true,
    [styles.contentChromeless]: state.chromeless,
    [styles.contentWithSidebar]: isExtensionSidebarOpen && !state.chromeless,
  });

  const { pathname, search } = locationService.getLocation();
  const url = pathname + search;
  const shouldShowReturnToPrevious = state.returnToPrevious && url !== state.returnToPrevious.href;

  // Clear returnToPrevious when the page is manually navigated to
  useEffect(() => {
    if (state.returnToPrevious && url === state.returnToPrevious.href) {
      chrome.clearReturnToPrevious('auto_dismissed');
    }
    // We only want to pay attention when the location changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chrome, url]);

  // Sync updates from kiosk mode query string back into app chrome
  useEffect(() => {
    const queryParams = locationSearchToObject(search);
    chrome.setKioskModeFromUrl(queryParams.kiosk);
  }, [chrome, search]);

  // Chromeless routes are without topNav, mega menu, search & command palette
  // We check chromeless twice here instead of having a separate path so {children}
  // doesn't get re-mounted when chromeless goes from true to false.
  return (
    <div
      id={floatingUtils.BOUNDARY_ELEMENT_ID}
      className={classNames('main-view', {
        'main-view--chrome-hidden': state.chromeless,
      })}
    >
      {!state.chromeless && (
        <LinkButton
          className={styles.skipLink}
          href="#pageContent"
          onClick={(e) => {
            e.preventDefault();
            document.getElementById('pageContent')?.focus();
          }}
        >
          <Trans i18nKey="app-chrome.skip-content-button">Skip to main content</Trans>
        </LinkButton>
      )}
      <div className={contentClass}>
        <div className={cx(styles.panes, { [styles.panesWithSidebar]: isExtensionSidebarOpen })}>
          {!state.chromeless && state.megaMenuDocked && (
            <MegaMenu className={styles.dockedMegaMenu} onClose={() => chrome.setMegaMenuOpen(false)} />
          )}
          {!state.chromeless && (
            <ErrorBoundaryAlert boundaryName="scopes-dashboards">
              <ScopesDashboards />
            </ErrorBoundaryAlert>
          )}
          <main
            className={cx(styles.pageContainer, {
              [styles.pageContainerWithSidebar]: !state.chromeless && isExtensionSidebarOpen,
              [contentSizeStyles.contentWidth]: !state.chromeless && isExtensionSidebarOpen,
            })}
            id="pageContent"
            tabIndex={-1}
          >
            {!state.chromeless && (
              <header className={styles.topNav}>
                <SingleTopBar
                  sectionNav={state.sectionNav.node}
                  pageNav={state.pageNav}
                  onToggleMegaMenu={() => chrome.setMegaMenuOpen(!state.megaMenuOpen)}
                  onToggleKioskMode={chrome.onToggleKioskMode}
                  actions={state.actions}
                  breadcrumbActions={state.breadcrumbActions}
                  inlineActions={state.inlineActions}
                  scopes={scopes}
                  showToolbarLevel={headerLevels === 2}
                />
              </header>
            )}
            {children}
          </main>
          {!state.chromeless && isExtensionSidebarOpen && (
            <Resizable
              className={styles.sidebarContainer}
              defaultSize={{ width: extensionSidebarWidth }}
              enable={{ left: true }}
              onResize={(_evt, _direction, ref) => setExtensionSidebarWidth(ref.getBoundingClientRect().width)}
              handleClasses={{ left: dragStyles.dragHandleBaseVertical }}
              minWidth={MIN_EXTENSION_SIDEBAR_WIDTH}
              maxWidth={MAX_EXTENSION_SIDEBAR_WIDTH}
            >
              <ExtensionSidebar />
            </Resizable>
          )}
        </div>
      </div>
      {!state.chromeless && !state.megaMenuDocked && <AppChromeMenu />}
      {!state.chromeless && <CommandPalette />}
      {shouldShowReturnToPrevious && state.returnToPrevious && (
        <ReturnToPrevious href={state.returnToPrevious.href} title={state.returnToPrevious.title} />
      )}
    </div>
  );
}

/**
 * The mega menu is a permanent docked sidebar on desktop (>= md) and an overlay drawer
 * with a hamburger trigger in the top bar on smaller screens.
 */
function useResponsiveDockedMegaMenu(chrome: AppChromeService) {
  const isDesktop = useMediaQueryMinWidth('md');

  useEffect(() => {
    const state = chrome.state.getValue();
    if (isDesktop && !state.megaMenuDocked) {
      chrome.setMegaMenuDocked(true, false);
      chrome.setMegaMenuOpen(store.getBool(DOCKED_MENU_OPEN_LOCAL_STORAGE_KEY, true));
    } else if (!isDesktop && state.megaMenuDocked) {
      chrome.setMegaMenuDocked(false, false);
      chrome.setMegaMenuOpen(false);
    }
  }, [isDesktop, chrome]);
}

const getStyles = (theme: GrafanaTheme2, megaMenuOpen: boolean) => {
  return {
    content: css({
      label: 'page-content',
      display: 'flex',
      flexDirection: 'row',
      flexGrow: 1,
      height: '100%',
    }),
    contentWithSidebar: css({
      height: '100vh',
      overflow: 'hidden',
    }),
    contentChromeless: css({
      paddingTop: 0,
    }),
    dockedMegaMenu: css({
      background: theme.colors.background.constPrimary,
      display: 'block',
      flexShrink: 0,
      width: megaMenuOpen ? 240 : 68,
      // Keep the sidebar (and its collapse button) pinned to the viewport while the page scrolls
      position: 'sticky',
      top: 0,
      alignSelf: 'flex-start',
      height: '100vh',
      overflow: 'hidden',

      [theme.breakpoints.down('md')]: {
        display: 'none',
      },
    }),
    topNav: css({
      display: 'flex',
      background: theme.colors.background.primary,
      flexDirection: 'column',
      paddingRight: 32,
      // Analytix: keep the header (breadcrumbs + dashboard toolbar) pinned while the page scrolls
      position: 'sticky',
      top: 0,
      zIndex: theme.zIndex.navbarFixed,
    }),
    panes: css({
      label: 'page-panes',
      display: 'flex',
      height: '100%',
      width: '100%',
      flexGrow: 1,
      minHeight: 0,
      flexDirection: 'column',
      [theme.breakpoints.up('md')]: {
        flexDirection: 'row',
      },
    }),
    panesWithSidebar: css({
      height: '100%',
      overflow: 'hidden',
      position: 'relative',
    }),
    pageContainer: css({
      label: 'page-container',
      display: 'flex',
      flexDirection: 'column',
      flexGrow: 1,
      minHeight: 0,
      minWidth: 0,
      // Analytix: the document scrolls (not this container) - overflow:auto here would
      // make the sticky header stick to this non-scrolling box instead of the viewport
      overflow: 'visible',
      '@media print': {
        overflow: 'visible',
      },
      '@page': {
        margin: 0,
        size: 'auto',
        padding: 0,
      },
    }),
    pageContainerWithSidebar: css({
      overflow: 'auto',
      height: '100%',
      minHeight: 0,
    }),
    skipLink: css({
      position: 'fixed',
      top: -1000,

      ':focus': {
        left: theme.spacing(1),
        top: theme.spacing(1),
        zIndex: theme.zIndex.portal,
      },
    }),
    sidebarContainer: css({
      // the `Resizeable` component overrides the needed `position` and `height`
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      position: 'fixed !important' as 'fixed',
      top: 0,
      bottom: 0,
      zIndex: theme.zIndex.navbarFixed + 1,
      right: 0,
    }),
  };
};

const getContentSizeStyles = (_: GrafanaTheme2, extensionSidebarWidth = 0) => {
  return {
    contentWidth: css({
      maxWidth: `calc(100% - ${extensionSidebarWidth}px) !important`,
    }),
  };
};
