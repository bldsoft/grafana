import { css } from '@emotion/css';
import { AriaRole, ReactNode } from 'react';
import * as React from 'react';
import SVG from 'react-inlinesvg';

import { GrafanaTheme2 } from '@grafana/data';

import { useStyles2 } from '../../themes';
import { Box } from '../Layout/Box/Box';
import { Stack } from '../Layout/Stack/Stack';
import { Text } from '../Text/Text';

interface Props {
  /**
   * Provide a button to render below the message
   */
  button?: ReactNode;
  hideImage?: boolean;
  /**
   * Override the default image for the variant
   */
  image?: ReactNode;
  /**
   * Message to display to the user
   */
  message: string;
  /**
   * Which variant to use. Affects the default image shown.
   */
  variant: 'call-to-action' | 'not-found' | 'completed';
  /**
   * Use to set `alert` when needed. See documentation for the use case
   */
  role?: AriaRole;
}

export const EmptyState = ({
  button,
  children,
  image,
  message,
  hideImage = true,
  variant,
  role,
}: React.PropsWithChildren<Props>) => {
  const styles = useStyles2(getStyles);

  return (
    <Box paddingY={4} display="flex" direction="column" alignItems="center" role={role}>
      <div className={styles.container}>
        <Stack direction="column" alignItems="center">
          <Text variant="h4" textAlignment="center">
            {message}
          </Text>
          {button && <div className={styles.button}>
            {button}
          </div>}
          {children && (
            <Text color="secondary" textAlignment="center">
              {children}
            </Text>
          )}
        </Stack>
      </div>
    </Box>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: theme.spacing(4),
    background: theme.colors.background.surfaceSecondary,
    borderRadius: theme.shape.radius.default,
    width: '100%',
    paddingTop: 32,
    paddingBottom: 32
  }),
  button: css({
    paddingTop: 24,
    paddingBottom: 24
  })
});
