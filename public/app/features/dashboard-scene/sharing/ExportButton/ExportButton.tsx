import { useCallback, useState } from 'react';

import { selectors as e2eSelectors } from '@grafana/e2e-selectors';
import { t } from '@grafana/i18n';
import { Dropdown, ToolbarButton } from '@grafana/ui';

import { DashboardScene } from '../../scene/DashboardScene';

import ExportMenu from './ExportMenu';

interface Props {
  dashboard: DashboardScene;
}

// Analytix: compact icon button with the export menu in a dropdown
export default function ExportButton({ dashboard }: Props) {
  const [isOpen, setIsOpen] = useState(false);

  const onMenuClick = useCallback((isOpen: boolean) => {
    setIsOpen(isOpen);
  }, []);

  const MenuActions = () => <ExportMenu dashboard={dashboard} />;

  return (
    <Dropdown overlay={MenuActions} placement="bottom-end" onVisibleChange={onMenuClick}>
      <ToolbarButton
        icon="download-alt"
        tooltip={t('export.menu.export-as-json-tooltip', 'Export')}
        aria-label={t('dashboard.export.button.label', 'Export dashboard')}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        data-testid={e2eSelectors.pages.Dashboard.DashNav.NewExportButton.arrowMenu}
      />
    </Dropdown>
  );
}
