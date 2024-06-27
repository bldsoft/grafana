import { css } from '@emotion/css';
import { cloneDeep } from 'lodash';
import React from 'react';

import { GrafanaTheme2, NavModelItem } from '@grafana/data';
import { Dropdown, ToolbarButton, useStyles2 } from '@grafana/ui';
import { config } from 'app/core/config';
import { contextSrv } from 'app/core/core';
import { useSelector } from 'app/types';

import { HOME_NAV_ID } from '../../../reducers/navModel';
import { Breadcrumbs } from '../../Breadcrumbs/Breadcrumbs';
import { buildBreadcrumbs } from '../../Breadcrumbs/utils';
import { enrichHelpItem } from '../MegaMenu/utils';
import { NewsContainer } from '../News/NewsContainer';
import { QuickAdd } from '../QuickAdd/QuickAdd';
import { TOP_BAR_LEVEL_HEIGHT } from '../types';

import { SignInLink } from './SignInLink';
import { TopNavBarMenu } from './TopNavBarMenu';
import { TopSearchBarCommandPaletteTrigger } from './TopSearchBarCommandPaletteTrigger';
import { TopSearchBarSection } from './TopSearchBarSection';

interface Props {
  sectionNav: NavModelItem;
  pageNav?: NavModelItem;
}

export const TopSearchBar = React.memo(function TopSearchBar({
                                                               sectionNav,
                                                               pageNav,
                                                             }: Props) {
  const styles = useStyles2(getStyles);
  const navIndex = useSelector((state) => state.navIndex);

  const helpNode = cloneDeep(navIndex['help']);
  const enrichedHelpNode = helpNode ? enrichHelpItem(helpNode) : undefined;
  const profileNode = navIndex['profile'];


  const homeNav = useSelector((state) => state.navIndex)[HOME_NAV_ID];
  const breadcrumbs = buildBreadcrumbs(sectionNav, pageNav, homeNav);

  console.log(contextSrv.user.gravatarUrl)


  return (
    <div className={styles.layout}>
      <Breadcrumbs breadcrumbs={breadcrumbs} className={styles.breadcrumbsWrapper} />
      <TopSearchBarSection align="right">
        <TopSearchBarCommandPaletteTrigger />
        <QuickAdd />
        {enrichedHelpNode && (
          <Dropdown overlay={() => <TopNavBarMenu node={enrichedHelpNode} />} placement="bottom-end">
            <ToolbarButton iconOnly icon="question-circle" aria-label="Help" />
          </Dropdown>
        )}
        {config.newsFeedEnabled && <NewsContainer />}
        {!contextSrv.user.isSignedIn && <SignInLink />}
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
  breadcrumbsWrapper: css({
    display: 'flex',
    overflow: 'hidden',
    [theme.breakpoints.down('sm')]: {
      minWidth: '50%',
    },
  }),
});

