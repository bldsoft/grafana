import { css } from '@emotion/css';
import { useRef } from 'react';
import * as React from 'react';

import { GrafanaTheme2 } from '@grafana/data';

import { useStyles2 } from '../../themes';

export const ScrollIndicators = ({ children }: React.PropsWithChildren<{}>) => {
  const scrollTopMarker = useRef<HTMLDivElement>(null);
  const scrollBottomMarker = useRef<HTMLDivElement>(null);
  const styles = useStyles2(getStyles);

  // Here we observe the top and bottom markers to determine if we should show the scroll indicators
  return (
    <>
      <div className={styles.scrollContent}>
        <div ref={scrollTopMarker} />
        {children}
        <div ref={scrollBottomMarker} />
      </div>
    </>
  );
};

const getStyles = (theme: GrafanaTheme2) => {
  return {
    scrollContent: css({
      flex: 1,
      position: 'relative',
    }),
  };
};
