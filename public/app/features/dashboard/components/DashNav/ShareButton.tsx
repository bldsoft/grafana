import { selectors as e2eSelectors } from '@grafana/e2e-selectors/src';
import { locationService } from '@grafana/runtime';
import { ToolbarButton } from '@grafana/ui'
import { DashboardModel } from 'app/features/dashboard/state/DashboardModel';
import { DashboardInteractions } from 'app/features/dashboard-scene/utils/interactions';

import { shareDashboardType } from '../ShareModal/utils';

export const ShareButton = ({ dashboard }: { dashboard: DashboardModel }) => {
  return (
    <ToolbarButton
      tooltip={'Share'}
      icon="share"
      data-testid={selectors.pages.Dashboard.DashNav.shareButton}
      onClick={() => {
        DashboardInteractions.toolbarShareClick();
        locationService.partial({ shareView: shareDashboardType.link });
      }}
    >
    </ToolbarButton>
  );
};
