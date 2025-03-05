import { css, keyframes } from '@emotion/css';

import { GrafanaTheme2 } from '@grafana/data';
import { locationService } from '@grafana/runtime';
import { Button, HorizontalGroup, Spinner, useStyles2, VerticalGroup } from '@grafana/ui';
import { DashboardInitPhase } from 'app/types';

export interface Props {
  initPhase: DashboardInitPhase;
}

export const DashboardLoading = ({ initPhase }: Props) => {
  const styles = useStyles2(getStyles);
  const cancelVariables = () => {
    locationService.push('/');
  };

  return (
    <div className={styles.dashboardLoading}>
      <div className={styles.dashboardLoadingText}>
        <VerticalGroup spacing="md">
          <HorizontalGroup align="center" justify="center" spacing="xs">
            <Spinner inline={true} /> {initPhase}
          </HorizontalGroup>{' '}
          <HorizontalGroup align="center" justify="center">
            <Button className={styles.loadingButton} variant="secondary" size="md" onClick={cancelVariables}>
              Cancel loading dashboard
            </Button>
          </HorizontalGroup>
        </VerticalGroup>
      </div>
    </div>
  );
};

export const getStyles = (theme: GrafanaTheme2) => {
  // Amount of time we want to pass before we start showing loading spinner
  const slowStartThreshold = '0.5s';

  const invisibleToVisible = keyframes`
    0% { opacity: 0; }
    100% { opacity: 100%; }
  `;

  return {
    dashboardLoading: css({
      height: '70vh',
      display: 'flex',
      opacity: '0%',
      alignItems: 'center',
      justifyContent: 'center',
      [theme.transitions.handleMotion('no-preference', 'reduce')]: {
        animation: `${invisibleToVisible} 0s step-end ${slowStartThreshold} 1 normal forwards`,
      },
    }),
    loadingButton: css({
      padding: '10px 24px',
      height: 44,
      borderRadius: 10
    }),
    dashboardLoadingText: css({
      fontSize: theme.typography.h4.fontSize,
    }),
  };
};
