import { css } from '@emotion/css';

import { GrafanaTheme2 } from '@grafana/data';

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
    '&:hover': {
      backgroundColor: theme.colors.background.buttonHovered,
      color: theme.colors.menu.fontColorHovered,
    },
  }),
  buttonActive: css({
    backgroundColor: theme.colors.background.buttonHovered,
    color: theme.colors.menu.fontColorHovered,
  }),
  icon: css({
    marginRight: 6,
  }),
});
