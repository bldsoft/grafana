import { css } from '@emotion/css';
import React from 'react';

import { GrafanaTheme2, NavModelItem } from '@grafana/data';
import { Dropdown, ToolbarButton, useStyles2 } from '@grafana/ui'
import { useSelector } from 'app/types';

import { HOME_NAV_ID } from '../../../reducers/navModel';
import { Breadcrumbs } from '../../Breadcrumbs/Breadcrumbs';
import { buildBreadcrumbs } from '../../Breadcrumbs/utils';
import { QuickAdd } from '../QuickAdd/QuickAdd';
import { TOP_BAR_LEVEL_HEIGHT } from '../types';

import { TopNavBarMenu } from './TopNavBarMenu';
import { TopSearchBarCommandPaletteTrigger } from './TopSearchBarCommandPaletteTrigger';
import { TopSearchBarSection } from './TopSearchBarSection';
import { OrganizationSwitcher } from '../OrganizationSwitcher/OrganizationSwitcher'
import { NavToolbarSeparator } from '../NavToolbar/NavToolbarSeparator'

interface Props {
  sectionNav: NavModelItem;
  pageNav?: NavModelItem;
  actions: React.ReactNode;
}

export const TopSearchBar = React.memo(function TopSearchBar({
                                                               sectionNav,
                                                               pageNav,
                                                               actions
                                                             }: Props) {
  const styles = useStyles2(getStyles);
  const navIndex = useSelector((state) => state.navIndex);

  // const helpNode = cloneDeep(navIndex['help']);
  // const enrichedHelpNode = helpNode ? enrichHelpItem(helpNode) : undefined;
  const profileNode = navIndex['profile'];
  // @ts-ignore
  const withoutSeparator = (actions && Object.prototype.hasOwnProperty.call(actions, 'length')) ? actions[actions.length - 1].key.includes('spacer') : false;

  const homeNav = useSelector((state) => state.navIndex)[HOME_NAV_ID];
  const breadcrumbs = buildBreadcrumbs(sectionNav, pageNav, homeNav);

  return (
    <div className={styles.layout}>
      <div className={styles.dFlex}>
        <OrganizationSwitcher />
        <Breadcrumbs breadcrumbs={breadcrumbs} className={styles.breadcrumbsWrapper} />
      </div>
      <div className={styles.actions}>
        {actions}
        {actions && !withoutSeparator && <NavToolbarSeparator />}
      </div>
      <TopSearchBarSection align="right">
        <TopSearchBarCommandPaletteTrigger />
        <QuickAdd />
        {/*{enrichedHelpNode && (*/}
        {/*  <Dropdown overlay={() => <TopNavBarMenu node={enrichedHelpNode} />} placement="bottom-end">*/}
        {/*    <ToolbarButton iconOnly icon="question-circle" aria-label="Help" />*/}
        {/*  </Dropdown>*/}
        {/*)}*/}
        {/*{config.newsFeedEnabled && <NewsContainer />}*/}
        {/*{!contextSrv.user.isSignedIn && <SignInLink />}*/}
        {profileNode && (
          <Dropdown overlay={() => <TopNavBarMenu node={profileNode} />} placement="bottom-end">
            <ToolbarButton
              className={styles.profileButton}
              imgSrc='public/img/avatar.png'
              imgAlt="User avatar"
              aria-label="Profile"
            />
          </Dropdown>
        )}
      </TopSearchBarSection>
    </div>
  );
});

const getStyles = (theme: GrafanaTheme2) => ({
  layout: css({
    height: TOP_BAR_LEVEL_HEIGHT,
    display: 'flex',
    gap: theme.spacing(1),
    alignItems: 'center',
    padding: theme.spacing(0, 1, 0, 2),
    justifyContent: 'space-between',
  }),
  img: css({
    height: theme.spacing(3),
    width: theme.spacing(3),
  }),
  logo: css({
    display: 'flex',
  }),
  profileButton: css({
    padding: theme.spacing(0, 0.25),
    img: {
      borderRadius: theme.shape.radius.circle,
      height: '24px',
      marginRight: 0,
      width: '24px',
    },
  }),
  dFlex: css({
    display: 'flex'
  }),
  breadcrumbsWrapper: css({
    display: 'flex',
    overflow: 'hidden',
    paddingLeft: 15,
    [theme.breakpoints.down('sm')]: {
      minWidth: '50%',
    },
  }),
  actions: css({
    label: 'NavToolbar-actions',
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'nowrap',
    justifyContent: 'flex-end',
    paddingLeft: theme.spacing(1),
    flexGrow: 1,
    gap: theme.spacing(1),
    minWidth: 0,

    '.body-drawer-open &': {
      display: 'none',
    },
  }),
});

