import { css, cx } from '@emotion/css';
import { useMemo, useState } from 'react';

import { GrafanaTheme2 } from '@grafana/data';
import { t } from '@grafana/i18n';
import { getDataSourceSrv, reportInteraction, config } from '@grafana/runtime';
import { Menu, Dropdown, useStyles2, Button, Icon } from '@grafana/ui';
import {
  CONTENT_KINDS,
  DashboardLibraryInteractions,
  SOURCE_ENTRY_POINTS,
} from 'app/features/dashboard/dashgrid/DashboardLibrary/interactions';
import { useSelector } from 'app/types/store';

import { findCreateActions } from './utils';

export interface Props {}

export const QuickAdd = ({}: Props) => {
  const styles = useStyles2(getStyles);
  const navBarTree = useSelector((state) => state.navBarTree);
  const [isOpen, setIsOpen] = useState(false);

  const createActions = useMemo(() => {
    const createActions = findCreateActions(navBarTree);

    if (config.featureToggles.dashboardTemplates) {
      const testDataSources = getDataSourceSrv().getList({ type: 'grafana-testdata-datasource' });
      if (testDataSources.length > 0) {
        createActions.splice(1, 0, {
          id: 'browse-template-dashboard',
          text: t('navigation.quick-add.new-template-dashboard-button', 'Dashboard from template'),
          url: '/dashboards?templateDashboards=true&source=quickAdd',
          onClick: () => {
            DashboardLibraryInteractions.entryPointClicked({
              entryPoint: SOURCE_ENTRY_POINTS.QUICK_ADD_BUTTON,
              contentKind: CONTENT_KINDS.TEMPLATE_DASHBOARD,
            });
          },
        });
      }
    }

    return createActions;
  }, [navBarTree]);
  const showQuickAdd = createActions.length > 0;

  if (!showQuickAdd) {
    return null;
  }
  const handleVisibleChange = () => {
    if (!isOpen) {
      reportInteraction('grafana_create_new_button_menu_opened', {
        from: 'quickadd',
      });
    }
    setIsOpen(!isOpen);
  };

  const MenuActions = () => {
    return (
      <Menu className={styles.menu}>
        {createActions.map((createAction, index) => (
          <Menu.Item
            key={index}
            url={createAction.url}
            label={createAction.text}
            onClick={() => {
              reportInteraction('grafana_menu_item_clicked', { url: createAction.url, from: 'quickadd' });
              createAction.onClick?.();
            }}
          />
        ))}
      </Menu>
    );
  };

  return showQuickAdd ? (
    <Dropdown overlay={MenuActions} placement="bottom-end" onVisibleChange={handleVisibleChange}>
      <Button
        type="button"
        aria-label={t('navigation.quick-add.aria-label', 'New')}
        className={cx(styles.addButton, { [styles.addButtonActive]: isOpen })}
      >
        <Icon name="plus" size="lg" className={styles.icon} /> Add
      </Button>
    </Dropdown>
  ) : null;
};

const getStyles = (theme: GrafanaTheme2) => ({
  menu: css({
    padding: '6px 8px',
    backgroundColor: theme.colors.background.surfacePrimary,
    borderRadius: 10,
    color: theme.colors.text.secondary,
  }),
  addButton: css({
    backgroundColor: theme.colors.background.surfacePrimary,
    color: theme.colors.text.secondary,
    height: 44,
    width: 89,
    borderRadius: '10px',
    padding: '10px 16px',
    justifyContent: 'center',
    marginLeft: 24,
    '&:hover': {
      backgroundColor: theme.colors.background.buttonHovered,
      color: theme.colors.menu.fontColorHovered,
    },
  }),
  addButtonActive: css({
    backgroundColor: theme.colors.background.buttonHovered,
    color: theme.colors.menu.fontColorHovered,
  }),
  icon: css({
    marginRight: 6,
  }),
});
