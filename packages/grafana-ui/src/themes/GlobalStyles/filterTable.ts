import { css } from '@emotion/react';

import { GrafanaTheme2 } from '@grafana/data';

export function getFilterTableStyles(theme: GrafanaTheme2) {
  return css({
    '.filter-table *': {
      boxSizing: 'border-box',
    },

    '.filter-table': {
      width: '100%',
      borderCollapse: 'separate',

      tbody: {
        'tr:nth-of-type(odd)': {
          background: theme.colors.emphasize(theme.colors.background.primary, 0.02),
        },
        tr: {
          borderRadius: '10px',
          height: '48px',
        },
      },

      th: {
        width: 'auto',
        padding: '16px 24px',
        textAlign: 'left',
        lineHeight: '16px',
        height: '16px',
        whiteSpace: 'nowrap',
      },

      td: {
        padding: '2px 24px',
        lineHeight: '16px',
        height: '16px',
        whiteSpace: 'nowrap',

        '&:first-child': {
          borderBottomLeftRadius: '10px',
          borderTopLeftRadius: '10px',
        },
        '&:last-child': {
          borderBottomRightRadius: '10px',
          borderTopRightRadius: '10px',
        },
      },

      '.link-td': {
        padding: 0,
        lineHeight: '30px',
        height: '30px',
        whiteSpace: 'nowrap',

        a: {
          display: 'block',
          padding: theme.spacing(0, 1),
          height: '30px',
        },
      },

      '.ellipsis': {
        display: 'block',
        width: '100%',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },

      '.expanded': {
        borderColor: theme.components.panel.background,
      },

      '.expanded > td': {
        paddingBottom: 0,
      },

      '.filter-table__avatar': {
        width: '25px',
        height: '25px',
        borderRadius: theme.shape.radius.circle,
      },

      '&--hover': {
        'tbody tr:hover': {
          background: theme.colors.emphasize(theme.colors.background.primary, 0.05),
        },
      },
    },
  });
}
