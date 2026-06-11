import { selectors as e2eSelectors } from '@grafana/e2e-selectors';
import { locationService } from '@grafana/runtime';
import { ToolbarButton } from '@grafana/ui';
import { DashboardInteractions } from 'app/features/dashboard-scene/utils/interactions';

import { shareDashboardType } from '../ShareModal/utils';

export const ShareButton = () => {
  return (
    <ToolbarButton
      tooltip={'Share'}
      icon="share"
      data-testid={e2eSelectors.pages.Dashboard.DashNav.shareButton}
      onClick={() => {
        DashboardInteractions.toolbarShareClick();
        locationService.partial({ shareView: shareDashboardType.link });
      }}
    />
  );
};
