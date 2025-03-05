import { css, cx } from '@emotion/css';
import { useMemo, useState } from 'react';

import { GrafanaTheme2 } from '@grafana/data';
import { selectors } from '@grafana/e2e-selectors'
import { reportInteraction } from '@grafana/runtime';
import { Menu, Dropdown, useStyles2, Button, Icon } from '@grafana/ui'
import { useSelector } from 'app/types';

import { findCreateActions } from './utils';

export interface Props {}

export const QuickAdd = ({}: Props) => {
  const styles = useStyles2(getStyles);
  // const theme = useTheme2();
  const navBarTree = useSelector((state) => state.navBarTree);

  const [isOpen, setIsOpen] = useState(false);
  const createActions = useMemo(() => findCreateActions(navBarTree), [navBarTree]);

  const MenuActions = () => {
    return (
      <Menu className={cx(styles.menu)}>
        {createActions.map((createAction, index) => (
          <Menu.Item
            key={index}
            url={createAction.url}
            label={createAction.text}
            onClick={() => reportInteraction('grafana_menu_item_clicked', { url: createAction.url, from: 'quickadd' })}
          />
        ))}
      </Menu>
    );
  };

  return createActions.length > 0 ? (
    <>
      <Dropdown overlay={MenuActions} placement="bottom-end" onVisibleChange={setIsOpen}>
        <Button
          type="button"
          data-testid={selectors.pages.Login.submit}
          className={cx(styles.addButton, {
            [styles.addButtonActive]: isOpen
          })}
        >
          <Icon name="plus" size="lg" className={styles.icon}/> Add
        </Button>
      </Dropdown>
    </>
  ) : null;
};

const getStyles = (theme: GrafanaTheme2) => ({
  menu: css({
    padding: '6px 8px',
    backgroundColor: theme.colors.background.surfacePrimary,
    borderRadius: 10,
    color: theme.colors.text.secondary,
  }),
  buttonContent: css({
    alignItems: 'center',
    display: 'flex',
  }),
  buttonText: css({
    [theme.breakpoints.down('md')]: {
      display: 'none',
    },
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
    }
  }),
  addButtonActive: css({
    backgroundColor: theme.colors.background.buttonHovered,
    color: theme.colors.menu.fontColorHovered,
  }),
  icon: css({
    marginRight: 6
  })
});
