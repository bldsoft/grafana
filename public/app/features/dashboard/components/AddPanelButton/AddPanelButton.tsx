import { useState, useEffect } from 'react';
import { selectors } from '@grafana/e2e-selectors'

import { Dropdown, ToolbarButton } from '@grafana/ui'
import { DashboardModel } from 'app/features/dashboard/state/DashboardModel';

import AddPanelMenu from './AddPanelMenu';

export interface Props {
  dashboard: DashboardModel;
  onToolbarAddMenuOpen?: () => void;
}

const AddPanelButton = ({ dashboard, onToolbarAddMenuOpen }: Props) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  useEffect(() => {
    if (isMenuOpen && onToolbarAddMenuOpen) {
      onToolbarAddMenuOpen();
    }
  }, [isMenuOpen, onToolbarAddMenuOpen]);

  return (
    <Dropdown
      overlay={() => <AddPanelMenu dashboard={dashboard} />}
      placement="bottom"
      offset={[0, 6]}
      onVisibleChange={setIsMenuOpen}
    >
      <ToolbarButton tooltip={'Add Panel'} icon="plus" data-testid={selectors.components.PageToolbar.itemButton('Add button')}>
      </ToolbarButton>
    </Dropdown>
  );
};

export default AddPanelButton;
