import { css } from '@emotion/css';
import { DOMAttributes } from '@react-types/shared';
import React, { forwardRef } from 'react';
import { useLocation } from 'react-router-dom';

import { GrafanaTheme2, locationUtil, textUtil } from '@grafana/data';
import { selectors } from '@grafana/e2e-selectors';
import { CustomScrollbar, IconButton, useStyles2, Stack } from '@grafana/ui';
import { useGrafana } from 'app/core/context/GrafanaContext';
import { t } from 'app/core/internationalization';
import { useSelector } from 'app/types';

import { MegaMenuItem } from './MegaMenuItem';
import { Branding } from '../../Branding/Branding';
import { enrichWithInteractionTracking, getActiveItem } from './utils';
import { config } from '@grafana/runtime'

export const MENU_WIDTH = '240px';

export interface Props extends DOMAttributes {
  onClose: () => void;
}

export const MegaMenu = React.memo(
  forwardRef<HTMLDivElement, Props>(({ onClose, ...restProps }, ref) => {
    const navTree = useSelector((state) => state.navBarTree);
    const location = useLocation();
    const { chrome } = useGrafana();
    const state = chrome.useState();
    const styles = useStyles2(getStyles, state.megaMenuOpen);

    // Remove profile + help from tree
    const navItems = navTree
      .filter((item) => item.id !== 'profile' && item.id !== 'help')
      .map((item) => enrichWithInteractionTracking(item, state.megaMenuDocked));

    const activeItem = getActiveItem(navItems, state.sectionNav.node, location.pathname);

    const handleOpenMenu = () => {
      chrome.setMegaMenuOpen(!state.megaMenuOpen);
    };

    let homeUrl = config.appSubUrl || '/';
    if (!config.bootData.user.isSignedIn && !config.anonymousEnabled) {
      homeUrl = textUtil.sanitizeUrl(locationUtil.getUrlForPartial(location, { forceLogin: 'true' }));
    }

    return (
      <div data-testid={selectors.components.NavMenu.Menu} ref={ref} {...restProps}>
        <nav className={styles.content}>
          <CustomScrollbar showScrollIndicators hideHorizontalTrack>
             <a className={styles.logo} href={homeUrl} title="Go to home">
               <Branding.MenuLogo className={styles.img} menuOpen={state.megaMenuOpen}/>
             </a>
            <ul className={styles.itemList} aria-label={t('navigation.megamenu.list-label', 'Navigation')}>
              {navItems.map((link) => (
                <Stack key={link.text} alignItems="center">
                  <MegaMenuItem
                    link={link}
                    onClick={state.megaMenuDocked ? undefined : onClose}
                    activeItem={activeItem}
                  />
                </Stack>
              ))}
            </ul>
          </CustomScrollbar>
          <IconButton
            id="dock-menu-button"
            className={styles.dockMenuButton}
            tooltip={
              state.megaMenuOpen
                ? t('navigation.megamenu.close', 'Open menu')
                : t('navigation.megamenu.open', 'Close menu')
            }
            name={state.megaMenuOpen ? 'angle-left' : 'angle-right'}
            onClick={handleOpenMenu}
            variant="secondary"
          />
        </nav>
      </div>
    );
  })
);

MegaMenu.displayName = 'MegaMenu';

const getStyles = (theme: GrafanaTheme2, megaMenuOpen: boolean) => ({
  content: css({
    display: 'flex',
    flexDirection: 'column',
    height: '99%',
    minHeight: 0,
    position: 'relative',
  }),
  mobileHeader: css({
    display: 'flex',
    justifyContent: 'space-between',
    padding: theme.spacing(1, 1, 1, 2),
    borderBottom: `1px solid ${theme.colors.border.weak}`,

    [theme.breakpoints.up('md')]: {
      display: 'none',
    },
  }),
  itemList: css({
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    listStyleType: 'none',
    padding: theme.spacing(1, 1, 2, 1),
    width: megaMenuOpen ? 240 : 120
  }),
  dockMenuButton: css({
    display: 'inline-flex',
    width: 'fit-content',
    alignSelf: 'end'
  }),
  img: css({
    height: megaMenuOpen ? 42 : 22,
    width: megaMenuOpen ? 184 : 22
  }),
  logo: css({
    marginTop: 30,
    marginBottom: 22,
    display: 'flex',
    justifyContent: 'center'
  }),
});
