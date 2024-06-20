import { css, cx } from '@emotion/css';
import React from 'react'

import { GrafanaTheme2, NavModelItem } from '@grafana/data'
import { selectors } from '@grafana/e2e-selectors';
import { Icon, Link, useTheme2 } from '@grafana/ui';
import { useGrafana } from '../../../context/GrafanaContext'
import Popup from 'reactjs-popup'

export interface Props {
  children: React.ReactNode;
  activeItem?: NavModelItem;
  isActive?: boolean;
  onClick?: () => void;
  target?: HTMLAnchorElement['target'];
  url: string;
  megaMenuClose?: boolean;
  link?: any
}

export function MegaMenuItemText({ children, isActive, activeItem, onClick, target, url, megaMenuClose, link }: Props) {
  const theme = useTheme2();
  const styles = getStyles(theme, isActive, megaMenuClose);
  const LinkComponent = !target && url.startsWith('/') ? Link : 'a';
  const { chrome } = useGrafana();
  const state = chrome.useState();

  let links = [link]
  if (link.children) {
    links = links.concat(link.children.filter((c: any) => !c.hideFromTabs))
  }

  const linkContent = (
    <div className={styles.linkContent}>
      {children}

      {
        // As nav links are supposed to link to internal urls this option should be used with caution
        target === '_blank' && <Icon data-testid="external-link-icon" name="external-link-alt" />
      }
    </div>
  );

  return (
    <>
      {(state.megaMenuOpen || !link.children) && <LinkComponent
        data-testid={selectors.components.NavMenu.item}
        className={cx(styles.container)}
        href={url}
        target={target}
        onClick={onClick}
        {...(isActive && { 'aria-current': 'page' })}
      >
        {linkContent}
      </LinkComponent>}
      {!state.megaMenuOpen && link.children && <div
        data-testid={selectors.components.NavMenu.item}
        className={cx(styles.container)}
        {...(isActive && { 'aria-current': 'page' })}
      >
        <Popup
          trigger={linkContent}
          position="right top"
          on="hover"
          closeOnDocumentClick
          mouseLeaveDelay={0}
          mouseEnterDelay={0}
          contentStyle={{ padding: '0 0 0 34px', border: 'none', marginTop: '-18px' }}
          arrow={false}
        >
          <div className={cx(styles.menu)}>
            {links.map(link =>
              <LinkComponent
                key={link.id}
                className={cx(styles.menuItem, {
                  [styles.activeMenuItem]: link === activeItem
                })}
                href={link.url}
                target={link.target}
              >
                {link.text}
              </LinkComponent>)}
          </div>
        </Popup>
      </div>
      }
    </>
  );
}

MegaMenuItemText.displayName = 'MegaMenuItemText';

const getStyles = (theme: GrafanaTheme2, isActive: Props['isActive'], megaMenuClose: Props['megaMenuClose']) => ({
  container: css({
    alignItems: 'center',
    color: 'inherit',
    height: '100%',
    position: 'relative',
    width: '100%',
    cursor: 'pointer',

    '&:focus-visible': {
      boxShadow: 'none',
      transition: 'none',
    },
  }),
  linkContent: css({
    alignItems: 'center',
    display: 'flex',
    gap: '0.5rem',
    height: '100%',
    width: '100%',
    justifyContent: megaMenuClose ? 'center' : 'unset',
  }),
  activeMenuItem: css({
    backgroundColor: theme.colors.menu.active,
    '&:hover': {
      backgroundColor: theme.colors.menu.selectedHovered,
    },
  }),
  menu: css({
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: '#262626',
    padding: 8,
    color: '#CCCCCC',
    fontSize: 16,
    borderRadius: 8
  }),
  menuItem: css({
    padding: '10px 12px',
    borderRadius: 8,
    margin: '3px 0',

    '&:hover': {
      backgroundColor: theme.colors.menu.hovered,
    },

    '&:focus-visible': {
      border: 'none',
      outline: 'none',
    },
  })
});
