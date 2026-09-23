import { css, cx } from '@emotion/css';
import { Suspense, lazy, useState } from 'react';

import { GrafanaTheme2 } from '@grafana/data';
import { t } from '@grafana/i18n';
import { Button, Icon, ToolbarButton, useStyles2 } from '@grafana/ui';
import { TOP_BAR_BUTTON_ATTR, getTopBarButtonStyles } from 'app/core/components/AppChrome/TopBar/topBarButton';

// Analytix: loaded on demand so pages that only show the button (e.g. the
// home page) do not pull the chat's heavy dependencies into their chunk.
const GenPanelChat = lazy(() => import('./GenPanelChat').then((m) => ({ default: m.GenPanelChat })));

/**
 * Analytix: kill switch for the AI panel button in the dashboard toolbars.
 * The dashboard placement is parked, not removed - flip this back to `true`
 * to bring the toolbar button back in both toolbars. Both registration sites
 * gate their `condition` on it. The button itself lives on the home page now
 * (see {@link ../../home/AnalytixHomePage.tsx}) and is not affected by this.
 * NOTE: when un-parking, also apply the access gate the home page uses
 * ({@link ./useAiInsiderAccess.ts}) so the button stays team-restricted.
 */
export const AI_PANEL_ENABLED = false;

interface Props {
  /**
   * When provided the button is a plain trigger and the caller owns the chat
   * state (the home page does, to report its own analytics). Without it the
   * button is self-contained: it opens the chat drawer itself.
   */
  onClick?: () => void;
}

/**
 * Toolbar action that opens the "generate panel from a description" chat.
 * Rendered in the header of the home page ({@link ../../home/AnalytixHomePage.tsx}).
 * Also registered (currently disabled via {@link AI_PANEL_ENABLED}) in
 * {@link ../scene/NavToolbarActions.tsx} (legacy toolbar) and
 * {@link ../scene/new-toolbar/RightActions.tsx} (new toolbar).
 */
export function GenPanelButton({ onClick }: Props) {
  const styles = useStyles2(getStyles);
  const [isOpen, setIsOpen] = useState(false);
  const label = t('dashboard.ai-panel.tooltip', 'Ask AI Insider');

  if (onClick) {
    // Analytix: the home-page entry point is a labelled button in the same
    // style as the neighbouring "+ Add" (see QuickAdd), not a small icon.
    return (
      <Button type="button" className={styles.button} aria-label={label} onClick={onClick} {...TOP_BAR_BUTTON_ATTR}>
        <Icon name="ai" size="lg" className={styles.icon} />
        <span className={styles.label}>{label}</span>
      </Button>
    );
  }

  return (
    <>
      <ToolbarButton icon="ai" tooltip={label} onClick={() => setIsOpen(true)} />
      {isOpen && (
        <Suspense fallback={null}>
          <GenPanelChat onClose={() => setIsOpen(false)} />
        </Suspense>
      )}
    </>
  );
}

const getStyles = (theme: GrafanaTheme2) => {
  const topBar = getTopBarButtonStyles(theme);

  return {
    button: cx(
      topBar.button,
      css({
        // Analytix: the icon alone is enough on phones, where the header has
        // no room for the label next to the org switcher and profile.
        [theme.breakpoints.down('sm')]: {
          padding: '10px 12px',
        },
      })
    ),
    icon: cx(
      topBar.icon,
      css({
        [theme.breakpoints.down('sm')]: {
          marginRight: 0,
        },
      })
    ),
    label: css({
      [theme.breakpoints.down('sm')]: {
        display: 'none',
      },
    }),
  };
};
