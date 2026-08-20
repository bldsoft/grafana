import { css } from '@emotion/css';
import React, { memo } from 'react';

import { GrafanaTheme2, NavModelItem } from '@grafana/data';
import { Components } from '@grafana/e2e-selectors';
import { t } from '@grafana/i18n';
import { ScopesContextValue } from '@grafana/runtime';
import { Icon, Stack, ToolbarButton, useStyles2 } from '@grafana/ui';
import { MEGA_MENU_TOGGLE_ID } from 'app/core/constants';
import { useGrafana } from 'app/core/context/GrafanaContext';
import { useMediaQueryMinWidth } from 'app/core/hooks/useMediaQueryMinWidth';
import { HOME_NAV_ID } from 'app/core/reducers/navModel';
import { ScopesSelector } from 'app/features/scopes/selector/ScopesSelector';
import { useSelector } from 'app/types/store';

import { Breadcrumbs } from '../../Breadcrumbs/Breadcrumbs';
import { buildBreadcrumbs } from '../../Breadcrumbs/utils';
import { ExtensionToolbarItem } from '../ExtensionSidebar/ExtensionToolbarItem';
import { OrganizationSwitcher } from '../OrganizationSwitcher/OrganizationSwitcher';
import { QuickAdd } from '../QuickAdd/QuickAdd';

import { ProfileButton } from './ProfileButton';
import { SingleTopBarActions } from './SingleTopBarActions';
import { TopBarExtensionPoint } from './TopBarExtensionPoint';
import { getChromeHeaderLevelHeight } from './useChromeHeaderHeight';

interface Props {
  sectionNav: NavModelItem;
  pageNav?: NavModelItem;
  onToggleMegaMenu(): void;
  onToggleKioskMode(): void;
  actions?: React.ReactNode;
  breadcrumbActions?: React.ReactNode;
  // Analytix: always rendered in this (first) header row, at every screen size
  inlineActions?: React.ReactNode;
  scopes?: ScopesContextValue | undefined;
  showToolbarLevel: boolean;
}

export const SingleTopBar = memo(function SingleTopBar({
  onToggleMegaMenu,
  onToggleKioskMode,
  pageNav,
  sectionNav,
  scopes,
  actions,
  breadcrumbActions,
  inlineActions,
  showToolbarLevel,
}: Props) {
  const { chrome } = useGrafana();
  const state = chrome.useState();
  const menuDockedAndOpen = !state.chromeless && state.megaMenuDocked && state.megaMenuOpen;
  const styles = useStyles2(getStyles, menuDockedAndOpen);
  const profileNode = useSelector((state) => state.navIndex['profile']);
  const homeNav = useSelector((state) => state.navIndex)[HOME_NAV_ID];
  const breadcrumbs = buildBreadcrumbs(sectionNav, pageNav, homeNav);
  const isSmallScreen = !useMediaQueryMinWidth('sm');
  const isLargeScreen = useMediaQueryMinWidth('lg');
  const topLevelScopes = !showToolbarLevel && isLargeScreen && scopes?.state.enabled;

  return (
    <>
      <div className={styles.layout}>
        <Stack minWidth={0} gap={0.5} alignItems="center" flex={{ xs: 2, lg: '0 1 auto' }}>
          {!state.megaMenuDocked && (
            <ToolbarButton
              narrow
              id={MEGA_MENU_TOGGLE_ID}
              onClick={onToggleMegaMenu}
              tooltip={t('navigation.megamenu.open', 'Open menu')}
              aria-expanded={state.megaMenuOpen}
            >
              <Stack gap={0} alignItems="center">
                <Icon name="bars" size="xl" />
              </Stack>
            </ToolbarButton>
          )}
          <OrganizationSwitcher />
          {topLevelScopes ? <ScopesSelector /> : undefined}
          <Breadcrumbs breadcrumbs={breadcrumbs} className={styles.breadcrumbsWrapper} />
          {!showToolbarLevel && breadcrumbActions}
        </Stack>

        <Stack
          gap={0.5}
          alignItems="center"
          justifyContent={'flex-end'}
          flex={{ xs: 1, lg: '0 1 auto' }}
          minWidth={0}
          data-testid={!showToolbarLevel ? Components.NavToolbar.container : undefined}
        >
          {/* Analytix: toolbar actions in the right corner next to search/profile, single-row header */}
          {inlineActions}
          {!showToolbarLevel && actions}
          <TopBarExtensionPoint />
          {/* Analytix: the command-palette search trigger is hidden — search is not part of this product. */}
          {!isSmallScreen && <QuickAdd />}
          {!isSmallScreen && <ExtensionToolbarItem compact={isSmallScreen} />}
          {profileNode && <ProfileButton profileNode={profileNode} onToggleKioskMode={onToggleKioskMode} />}
        </Stack>
      </div>
      {showToolbarLevel && (
        <SingleTopBarActions scopes={scopes} actions={actions} breadcrumbActions={breadcrumbActions} />
      )}
    </>
  );
});

const getStyles = (theme: GrafanaTheme2, menuDockedAndOpen: boolean) => ({
  layout: css({
    height: getChromeHeaderLevelHeight(),
    display: 'flex',
    gap: theme.spacing(2),
    alignItems: 'center',
    padding: theme.spacing(0, 1, 0, 2),
    justifyContent: 'space-between',
  }),
  breadcrumbsWrapper: css({
    display: 'flex',
    overflow: 'hidden',
    // Analytix: size to content (full path visible), shrink with ellipsis only when tight;
    // the toolbar actions sit right after the breadcrumbs in the single-row header
    flex: '0 1 auto',
    minWidth: 0,
    [theme.breakpoints.down('sm')]: {
      minWidth: '40%',
    },
  }),
  img: css({
    alignSelf: 'center',
    height: theme.spacing(3),
    width: theme.spacing(3),
  }),
  kioskToggle: css({
    [theme.breakpoints.down('lg')]: {
      display: 'none',
    },
  }),
});
