import { selectors as e2eSelectors } from '@grafana/e2e-selectors';
import { t } from '@grafana/i18n';
import { locationService } from '@grafana/runtime';
import { VizPanel } from '@grafana/scenes';
import { ToolbarButton } from '@grafana/ui';

import { shareDashboardType } from '../../../dashboard/components/ShareModal/utils';
import { DashboardScene } from '../../scene/DashboardScene';
import { DashboardInteractions } from '../../utils/interactions';

const newShareButtonSelector = e2eSelectors.pages.Dashboard.DashNav.newShareButton;

// Analytix: single share icon opening the share drawer, like the pre-12.x design
export default function ShareButton({ dashboard, panel }: { dashboard: DashboardScene; panel?: VizPanel }) {
  return (
    <ToolbarButton
      icon="share-alt"
      tooltip={t('share-dashboard.share-button', 'Share')}
      data-testid={newShareButtonSelector.shareLink}
      onClick={() => {
        DashboardInteractions.toolbarShareClick();
        locationService.partial({ shareView: shareDashboardType.link });
      }}
    />
  );
}
