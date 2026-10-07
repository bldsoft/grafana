import { css, cx } from '@emotion/css';

import { GrafanaTheme2 } from '@grafana/data';
import { t } from '@grafana/i18n';
import { locationService, reportInteraction } from '@grafana/runtime';
import { Button, Icon, useStyles2 } from '@grafana/ui';
import { TOP_BAR_BUTTON_ATTR, getTopBarButtonStyles } from 'app/core/components/AppChrome/TopBar/topBarButton';

export const ALERTS_PATH = '/ai-insider/alerts';

/**
 * Analytix: header entry point of AI Insider Alerts, next to "Ask AI Insider"
 * in the same button group. Rendered only for members of the organisation's
 * AI Insider team (the caller applies useAiInsiderAccess).
 */
export function AlertsButton() {
  const styles = useStyles2(getStyles);
  const label = t('ai-insider-alerts.button', 'Alerts');

  const handleClick = () => {
    reportInteraction('analytix_ai_alerts_opened');
    locationService.push(ALERTS_PATH);
  };

  return (
    <Button
      type="button"
      className={styles.button}
      aria-label={t('ai-insider-alerts.button-aria', 'AI Insider alerts')}
      onClick={handleClick}
      {...TOP_BAR_BUTTON_ATTR}
    >
      <Icon name="bell" size="lg" className={styles.icon} />
      <span className={styles.label}>{label}</span>
    </Button>
  );
}

const getStyles = (theme: GrafanaTheme2) => {
  const topBar = getTopBarButtonStyles(theme);

  return {
    button: cx(
      topBar.button,
      css({
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
