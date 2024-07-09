import { css, cx } from '@emotion/css';
import React, { ReactElement, useCallback, useRef } from 'react';

import { GrafanaTheme2 } from '@grafana/data';
import { selectors as e2eSelectors } from '@grafana/e2e-selectors';

import { useStyles2 } from '../../themes';
import { Icon } from '../Icon/Icon';

import { PanelMenu } from './PanelMenu';

interface Props {
  children?: React.ReactNode;
  menu?: ReactElement | (() => ReactElement);
  title?: string;
  dragClass?: string;
  onOpenMenu?: () => void;
}

export function HoverWidget({ menu, title, dragClass, children, onOpenMenu }: Props) {
  const styles = useStyles2(getStyles);
  const draggableRef = useRef<HTMLDivElement>(null);
  const selectors = e2eSelectors.components.Panels.Panel.HoverWidget;
  // Capture the pointer to keep the widget visible while dragging
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggableRef.current?.setPointerCapture(e.pointerId);
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggableRef.current?.releasePointerCapture(e.pointerId);
  }, []);

  if (children === undefined || React.Children.count(children) === 0) {
    return null;
  }

  return (
    <div className={cx(styles.container, 'show-on-hover')} data-testid={selectors.container}>
      {dragClass && (
        <div
          className={cx(styles.square, styles.draggable, dragClass)}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          ref={draggableRef}
          data-testid={selectors.dragIcon}
        >
          <Icon name="expand-arrows" className={styles.draggableIcon} />
        </div>
      )}
      {children}
      {menu && (
        <PanelMenu
          menu={menu}
          title={title}
          placement="bottom"
          menuButtonClass={styles.menuButton}
          onOpenMenu={onOpenMenu}
        />
      )}
    </div>
  );
}

function getStyles(theme: GrafanaTheme2) {
  return {
    container: css({
      label: 'hover-container-widget',
      [theme.transitions.handleMotion('no-preference', 'reduce')]: {
        transition: `all .1s linear`,
      },
      display: 'flex',
      position: 'absolute',
      zIndex: 1,
      right: 0,
      boxSizing: 'content-box',
      alignItems: 'center',
      color: theme.colors.text.primary,
      background: 'transparent',
      borderRadius: theme.shape.radius.default,
      height: theme.spacing(4),
    }),
    square: css({
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      width: theme.spacing(4),
      height: '100%',
    }),
    draggable: css({
      cursor: 'move',
      // mobile do not support draggable panels
      [theme.breakpoints.down('md')]: {
        display: 'none',
      },
    }),
    menuButton: css({
      // Background and border are overriden when topnav toggle is disabled
      background: 'inherit',
      border: 'none',
      width: 32,
      height: 32,
      padding: 0,
      justifyContent: 'center',
      '&:hover': {
        color: theme.colors.text.active,
        background: theme.colors.border.teriary,
      },
    }),
    draggableIcon: css({
      transform: 'rotate(45deg)',
      color: theme.colors.text.secondary,
      '&:hover': {
        color: theme.colors.text.primary,
      },
    }),
  };
}
