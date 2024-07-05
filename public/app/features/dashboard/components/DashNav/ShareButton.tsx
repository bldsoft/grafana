import React from 'react';

import { selectors } from '@grafana/e2e-selectors/src'
import { locationService } from '@grafana/runtime';
import { ToolbarButton } from '@grafana/ui'
import { DashboardInteractions } from 'app/features/dashboard-scene/utils/interactions';

export const ShareButton = () => {
  return (
    <ToolbarButton
      tooltip={'Share'}
      icon="share"
      data-testid={selectors.pages.Dashboard.DashNav.shareButton}
      onClick={() => {
        DashboardInteractions.toolbarShareClick();
        locationService.partial({ shareView: 'link' });
      }}
    >
    </ToolbarButton>
  );
};
