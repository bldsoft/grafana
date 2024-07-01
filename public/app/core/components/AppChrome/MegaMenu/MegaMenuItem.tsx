import { css, cx } from '@emotion/css';
import React, { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useLocalStorage } from 'react-use';

import { GrafanaTheme2, NavModelItem, toIconName } from '@grafana/data';
import { useStyles2, Text, IconButton, Icon, Stack } from '@grafana/ui';
import { useGrafana } from 'app/core/context/GrafanaContext';

import { Indent } from '../../Indent/Indent';

import { FeatureHighlight } from './FeatureHighlight';
import { MegaMenuItemText } from './MegaMenuItemText';
import { hasChildMatch } from './utils';

interface Props {
  link: NavModelItem;
  activeItem?: NavModelItem;
  onClick?: () => void;
  level?: number;
}

const MAX_DEPTH = 2;

export function MegaMenuItem({ link, activeItem, level = 0, onClick }: Props) {
  const { chrome } = useGrafana();
  const state = chrome.useState();
  const menuIsOpen = state.megaMenuOpen
  const location = useLocation();
  const FeatureHighlightWrapper = link.highlightText ? FeatureHighlight : React.Fragment;
  const hasActiveChild = hasChildMatch(link, activeItem);
  const isActive = link === activeItem || (level === MAX_DEPTH && hasActiveChild);
  const [sectionExpanded, setSectionExpanded] = useLocalStorage(
    `grafana.navigation.expanded[${link.text}]`,
    Boolean(hasActiveChild)
  );
  const showExpandButton = level < MAX_DEPTH && Boolean(linkHasChildren(link) || link.emptyMessage);
  const item = useRef<HTMLLIElement>(null);

  const styles = useStyles2(getStyles, state.megaMenuOpen);

  // expand parent sections if child is active
  useEffect(() => {
    if (hasActiveChild) {
      setSectionExpanded(true);
    }
  }, [hasActiveChild, location, menuIsOpen, setSectionExpanded]);

  // scroll active element into center if it's offscreen
  useEffect(() => {
    if (isActive && item.current && isElementOffscreen(item.current)) {
      item.current.scrollIntoView({
        block: 'center',
      });
    }
  }, [isActive]);

  if (!link.url) {
    return null;
  }

  let iconElement: React.JSX.Element | null = null;
  if (link.icon) {
    iconElement = <Icon className={styles.icon} filled={hasActiveChild || isActive} name={toIconName(link.icon) ?? 'link'} size={state.megaMenuOpen ? 'lg' : 'xl'} />;
  } else if (link.img) {
    iconElement = (
      <Stack width={3} justifyContent="center">
        <img className={styles.img} src={link.img} alt="" />
      </Stack>
    );
  }

  return (
    <li ref={item} className={cx(styles.listItem, {
      [styles.jcC]: !state.megaMenuOpen
    })}>
      <div
        className={cx(styles.menuItem, {
          [styles.menuItemWithIcon]: Boolean(level === 0 && iconElement),
          [styles.containerActive]: isActive || (!state.megaMenuOpen && hasActiveChild),
          [styles.collapsedMenu]: !state.megaMenuOpen,
        })}
      >
        {level !== 0 && <Indent level={level === MAX_DEPTH ? level - 1 : level} spacing={3} />}
        {level === MAX_DEPTH && <div className={styles.itemConnector} />}
        <div className={styles.collapsibleSectionWrapper}>
          <MegaMenuItemText
            isActive={isActive}
            megaMenuClose={!state.megaMenuOpen}
            activeItem={activeItem}
            link={link}
            onClick={() => {
              link.onClick?.();
              onClick?.();
            }}
            target={link.target}
            url={link.url}
          >
            <div
              className={cx(styles.labelWrapper, {
                [styles.hasActiveChild]: hasActiveChild,
                [styles.labelWrapperWithIcon]: Boolean(level === 0 && iconElement),
                [styles.jcC]: !state.megaMenuOpen
              })}
            >
              {level === 0 && iconElement && <FeatureHighlightWrapper>{iconElement}</FeatureHighlightWrapper>}
              <Text truncate textAlignment={state.megaMenuOpen ? 'left' : 'center'}>{link.text}</Text>
            </div>
          </MegaMenuItemText>
        </div>
        {state.megaMenuOpen && (
          <div className={styles.collapseButtonWrapper}>
            {showExpandButton && (
              <IconButton
                aria-label={`${sectionExpanded ? 'Collapse' : 'Expand'} section ${link.text}`}
                className={styles.collapseButton}
                onClick={() => setSectionExpanded(!sectionExpanded)}
                name={sectionExpanded ? 'angle-up' : 'angle-down'}
                size="md"
                variant="secondary"
              />
            )}
          </div>
        )}
      </div>
      {state.megaMenuOpen && showExpandButton && sectionExpanded && (
        <ul className={styles.children}>
          {linkHasChildren(link) ? (
            link.children
              .filter((childLink) => !childLink.isCreateAction)
              .map((childLink) => (
                <MegaMenuItem
                  key={`${link.text}-${childLink.text}`}
                  link={childLink}
                  activeItem={activeItem}
                  onClick={onClick}
                  level={level + 1}
                />
              ))
          ) : (
            <div className={styles.emptyMessage} aria-live="polite">
              {link.emptyMessage}
            </div>
          )}
        </ul>
      )}
    </li>
  );
}

const getStyles = (theme: GrafanaTheme2, megaMenuOpen: boolean) => ({
  icon: css({
    width: theme.spacing(3),
    color: 'inherit'
  }),
  img: css({
    height: theme.spacing(2),
    width: theme.spacing(2),
  }),
  listItem: css({
    flex: 1,
    maxWidth: '100%',
  }),
  jcC: css({
    display: 'flex',
    justifyContent: 'center',
  }),
  menuItem: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    height: 44,
    paddingLeft: theme.spacing(0.5),
    position: 'relative',
    width: '100%',
    borderRadius: 10,
    margin: '3px 0',
    color: theme.colors.menu.fontColor,

    '&:hover': {
      backgroundColor: theme.colors.menu.hovered,
      color: theme.colors.menu.fontColorHovered
    }
  }),
  menuItemWithIcon: css({
    paddingLeft: theme.spacing(0),
  }),
  collapseButtonWrapper: css({
    display: 'flex',
    justifyContent: 'center',
    width: theme.spacing(3),
    flexShrink: 0,
  }),
  itemConnector: css({
    position: 'relative',
    height: '100%',
    width: theme.spacing(1.5),
    '&::before': {
      borderLeft: `1px solid ${theme.colors.border.medium}`,
      content: '""',
      height: '100%',
      right: 0,
      position: 'absolute',
      transform: 'translateX(50%)',
    },
  }),
  collapseButton: css({
    margin: 0,
    color: 'inherit'
  }),
  containerActive: css({
    color: theme.colors.menu.fontColorHovered,
    backgroundColor: theme.colors.menu.active,

    '&:hover': {
      background: theme.colors.menu.selectedHovered,
    },
  }),
  collapsedMenu: css({
    height: 86,
    width: 86,
    padding: '18px 10px',
    position: 'relative',
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
    flexDirection: megaMenuOpen ? 'row' : 'column',
    alignItems: 'center',
    gap: megaMenuOpen ? theme.spacing(1) : theme.spacing(0.5),
    width: '100%',
    paddingLeft: megaMenuOpen ? theme.spacing(1) : 0,
  }),
  labelWrapperWithIcon: css({
    paddingLeft: megaMenuOpen ? theme.spacing(0.5) : 0,
  }),
  hasActiveChild: css({
    color: theme.colors.text.active,
  }),
  children: css({
    display: 'flex',
    listStyleType: 'none',
    flexDirection: 'column',
  }),
  emptyMessage: css({
    color: theme.colors.text.secondary,
    fontStyle: 'italic',
    padding: theme.spacing(1, 1.5, 1, 7),
  }),
});

function linkHasChildren(link: NavModelItem): link is NavModelItem & { children: NavModelItem[] } {
  return Boolean(link.children && link.children.length > 0);
}

function isElementOffscreen(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return rect.bottom < 0 || rect.top >= window.innerHeight;
}
