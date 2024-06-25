import { css, cx } from '@emotion/css';
import React, { useEffect, useState } from 'react'

import { GrafanaTheme2, NavModelItem } from '@grafana/data'
import { selectors } from '@grafana/e2e-selectors';
import { Icon, IconButton, Link, useTheme2 } from '@grafana/ui'
import { useGrafana } from '../../../context/GrafanaContext'
import Popup from 'reactjs-popup'
import { hasChildMatch } from './utils'

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

  let links = [ { ...link, parent: true }]
  if (link.children) {
    links = links.concat(link.children.filter((c: any) => !c.hideFromTabs))
  }
  links.forEach((link) => {
    link.sectionExpanded = window.localStorage.getItem(`grafana.navigation.expanded[${link.text}]`) === 'true'
    link.hasActiveChild = hasChildMatch(link, activeItem)
  })

  const linkContent = (
    <div className={styles.linkContent}>
      {children}

      {
        // As nav links are supposed to link to internal urls this option should be used with caution
        target === '_blank' && <Icon data-testid="external-link-icon" name="external-link-alt" />
      }
    </div>
  );

  const [sectionExpanded, setSectionExpanded] = useState({});

  const sectionExpand = (link: any) => {
    link.sectionExpanded = !link.sectionExpanded
    window.localStorage.setItem(`grafana.navigation.expanded[${link.text}]`, link.sectionExpanded)
    setSectionExpanded({ ...link })
  }
  useEffect(() => {
    links.forEach((link) => {
      link.hasActiveChild = hasChildMatch(link, activeItem)
    })
  }, [sectionExpanded]);

  useEffect(() => {
    links.forEach((link) => {
      link.sectionExpanded = link.hasActiveChild = hasChildMatch(link, activeItem) || (window.localStorage.getItem(`grafana.navigation.expanded[${link.text}]`) === 'true');
    })
  },[])


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
            {links.map(link => <div key={link.id}>
              <div className={cx(styles.jcSB, styles.menuItem, {
                [styles.activeMenuItem]: link.id === activeItem?.id || (!link.parent && link.hasActiveChild)
              })}>
                <LinkComponent
                  href={link.url}
                  target={link.target}
                >
                  {link.text}
                </LinkComponent>
                {!link.parent && link.children &&
                  <div className={styles.collapseButtonWrapper}>
                    <IconButton
                      aria-label={`${link.sectionExpanded ? 'Collapse' : 'Expand'} section ${link.text}`}
                      className={styles.collapseButton}
                      onClick={() => sectionExpand(link)}
                      name={link.sectionExpanded ? 'angle-up' : 'angle-down'}
                      size="md"
                      variant="secondary"
                    />
                  </div>}
              </div>
              {!link.parent && link.sectionExpanded && <div className={styles.subMenu}>
                {link.children.map((ch: any) =>
                  <LinkComponent
                    key={ch.id}
                    className={cx(styles.menuItem, {
                      [styles.activeMenuItem]: ch.id === activeItem?.id,
                    })}
                    href={ch.url}
                    target={ch.target}
                  >
                    {ch.text}
                  </LinkComponent>
                )}
              </div>}
            </div>)}
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
  subMenu: css({
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: '#262626',
    padding: '0 8px',
    color: '#CCCCCC',
    fontSize: 16,
    borderRadius: 8
  }),
  jcSB: css({
    display: 'flex',
    justifyContent: 'space-between',
  }),
  menuItem: css({
    padding: '10px 12px',
    width: '100%',
    borderRadius: 8,
    margin: '3px 0',

    '&:hover': {
      backgroundColor: theme.colors.menu.hovered,
    },

    '&:focus-visible': {
      border: 'none',
      outline: 'none',
    },
  }),
  collapseButtonWrapper: css({
    display: 'flex',
    justifyContent: 'center',
    width: theme.spacing(3),
    flexShrink: 0,
  }),
  collapsibleSectionWrapper: css({
    alignItems: 'center',
    display: 'flex',
    flex: 1,
    height: '100%',
    minWidth: 0,
  }),
  labelWrapper: css({
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing(2),
    width: '100%',
    paddingLeft: theme.spacing(1),
  }),
  hasActiveChild: css({
    color: theme.colors.text.primary,
  }),
  collapseButton: css({
    margin: 0,
    color: 'inherit'
  }),
});
