import { css } from '@emotion/css';
import { DOMAttributes } from '@react-types/shared';
import React, { forwardRef } from 'react';
import { useLocation } from 'react-router-dom';

import { GrafanaTheme2 } from '@grafana/data';
import { selectors } from '@grafana/e2e-selectors';
import { CustomScrollbar, IconButton, useStyles2, Stack } from '@grafana/ui';
import { useGrafana } from 'app/core/context/GrafanaContext';
import { t } from 'app/core/internationalization';
import { useSelector } from 'app/types';

import { MegaMenuItem } from './MegaMenuItem';
import { enrichWithInteractionTracking, getActiveItem } from './utils';

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

    return (
      <div data-testid={selectors.components.NavMenu.Menu} ref={ref} {...restProps}>
        <nav className={styles.content}>
          <CustomScrollbar showScrollIndicators hideHorizontalTrack>
            <ul className={styles.itemList} aria-label={t('navigation.megamenu.list-label', 'Navigation')}>
              {navItems.map((link, index) => (
                <Stack key={link.text} alignItems="center">
                  <MegaMenuItem
                    link={link}
                    onClick={state.megaMenuDocked ? undefined : onClose}
                    activeItem={activeItem}
                  />

                </Stack>
              ))}
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
            </ul>
          </CustomScrollbar>
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
    height: '100%',
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
});
