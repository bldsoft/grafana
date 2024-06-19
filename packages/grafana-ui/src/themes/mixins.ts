import tinycolor from 'tinycolor2';

import { GrafanaTheme, GrafanaTheme2 } from '@grafana/data';

export function hoverColor(color: string, theme: GrafanaTheme2): string {
  return theme.isDark ? tinycolor(color).brighten(2).toString() : tinycolor(color).darken(2).toString();
}

export function listItem(theme: GrafanaTheme2): string {
  return `
  background: ${theme.colors.background.secondary};
  &:hover {
    background: ${hoverColor(theme.colors.background.secondary, theme)};
  }
  border-radius: ${theme.shape.radius.default};
`;
}

export function listItemSelected(theme: GrafanaTheme2): string {
  return `
    background: ${hoverColor(theme.colors.background.secondary, theme)};
    color: ${theme.colors.text.maxContrast};
`;
}

export function mediaUp(breakpoint: string) {
  return `only screen and (min-width: ${breakpoint})`;
}

export const focusCss = (theme: GrafanaTheme | GrafanaTheme2) => {

  return `
  outline: 2px dotted transparent;
  outline-offset: 2px;
  transition-property: outline, outline-offset, box-shadow;
  transition-duration: 0.2s;
  transition-timing-function: cubic-bezier(0.19, 1, 0.22, 1);`;
};

export function getMouseFocusStyles(theme: GrafanaTheme | GrafanaTheme2) {
  return {
    outline: 'none',
    boxShadow: `none`,
  };
}

export function getFocusStyles(theme: GrafanaTheme2) {
  return {
    outline: '2px dotted transparent',
    outlineOffset: '2px',
    transitionTimingFunction: `cubic-bezier(0.19, 1, 0.22, 1)`,
    transitionDuration: '0.2s',
    transitionProperty: 'outline, outline-offset, box-shadow',
  };
}

// max-width is set up based on .grafana-tooltip class that's used in dashboard
export const getTooltipContainerStyles = (theme: GrafanaTheme2) => ({
  overflow: 'hidden',
  background: theme.colors.background.secondary,
  maxWidth: '800px',
  padding: theme.spacing(1),
  borderRadius: theme.shape.radius.default,
  zIndex: theme.zIndex.tooltip,
});
