import { css } from '@emotion/css';

import { GrafanaTheme2 } from '@grafana/data';

/**
 * Analytix: marker attribute every header-group button carries so the group
 * can collapse the gap between consecutive buttons (see `button` below).
 * Spread it onto the `Button` element next to `className`.
 */
export const TOP_BAR_BUTTON_ATTR = { 'data-topbar-button': '' } as const;

// Analytix: shared look of the buttons in the header's right corner ("+ Add",
// "Ask AI Insider") so they read as one group regardless of where each one is
// rendered from.
export const getTopBarButtonStyles = (theme: GrafanaTheme2) => ({
  button: css({
    backgroundColor: theme.colors.background.surfacePrimary,
    color: theme.colors.text.secondary,
    height: 44,
    // eslint-disable-next-line @grafana/no-border-radius-literal -- Analytix: exact radius from the approved header design
    borderRadius: '10px',
    padding: '10px 16px',
    justifyContent: 'center',
    // The group is set apart from whatever sits to its left; consecutive
    // group buttons keep only the header's own small gap between them.
    marginLeft: 24,
    '[data-topbar-button] + &': {
      marginLeft: 0,
    },
    // The default (primary) Button variant turns green on :focus. The header
    // group has no such state: focus lands back on the trigger when a drawer
    // or menu closes, and the button must look idle again, not green. Listed
    // before :hover so hovering a focused button still shows the hover look.
    '&:focus, &:focus-visible': {
      backgroundColor: theme.colors.background.surfacePrimary,
      color: theme.colors.text.secondary,
    },
    '&:hover': {
      backgroundColor: theme.colors.background.buttonHovered,
      color: theme.colors.menu.fontColorHovered,
    },
  }),
  buttonActive: css({
    '&, &:focus, &:focus-visible': {
      backgroundColor: theme.colors.background.buttonHovered,
      color: theme.colors.menu.fontColorHovered,
    },
  }),
  icon: css({
    marginRight: 6,
  }),
});
