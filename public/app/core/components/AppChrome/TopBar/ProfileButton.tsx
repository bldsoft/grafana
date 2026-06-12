import { css } from '@emotion/css';
import { cloneDeep } from 'lodash';

import { GrafanaTheme2, NavModelItem } from '@grafana/data';
import { t } from '@grafana/i18n';
import { config } from '@grafana/runtime';
import { Dropdown, Menu, MenuItem, ToolbarButton, useStyles2 } from '@grafana/ui';

import { enrichWithInteractionTracking } from '../MegaMenu/utils';

import { TopNavBarMenu } from './TopNavBarMenu';

export interface Props {
  profileNode: NavModelItem;
  onToggleKioskMode: () => void;
}

export function ProfileButton({ profileNode }: Props) {
  const styles = useStyles2(getStyles);
  const node = enrichWithInteractionTracking(cloneDeep(profileNode), false);

  if (!node) {
    return null;
  }

  // Analytix: kiosk mode and blog feed entries are hidden
  const renderMenu = () => (
    <TopNavBarMenu node={profileNode}>
      <>
        <Menu.Divider />
        {!config.auth.disableSignoutMenu && (
          <MenuItem
            url={`${config.appSubUrl}/logout`}
            label={t('nav.sign-out.title', 'Sign out')}
            icon="arrow-from-right"
            target={'_self'}
          />
        )}
      </>
    </TopNavBarMenu>
  );

  return (
    <Dropdown overlay={renderMenu} placement="bottom-end">
      <ToolbarButton
        className={styles.profileButton}
        imgSrc="public/img/avatar.png"
        imgAlt="User avatar"
        aria-label={t('navigation.profile.aria-label', 'Profile')}
      />
    </Dropdown>
  );
}

const getStyles = (theme: GrafanaTheme2) => {
  return {
    profileButton: css({
      padding: theme.spacing(0, 0.5),
      img: {
        borderRadius: theme.shape.radius.circle,
        height: '24px',
        marginRight: 0,
        width: '24px',
      },
    }),
  };
};
