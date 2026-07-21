import { css } from '@emotion/css';
import { MouseEvent } from 'react';

import { GrafanaTheme2 } from '@grafana/data';
import { t } from '@grafana/i18n';
import { useStyles2 } from '@grafana/ui';

import { FavoriteIcon, OpenArrowIcon, getDashboardIcon } from './analytixIcons';
import { analytix } from './analytixTokens';
import { AnalytixDashboard } from './useAnalytixDashboards';

interface Props {
  dashboard: AnalytixDashboard;
  onOpen: (dashboard: AnalytixDashboard) => void;
  onToggleFavorite: (dashboard: AnalytixDashboard) => void;
}

// Analytix: dashboard card from the approved home-page design. Card anatomy
// follows COMPONENT_SPEC.md - icon, title, one-line description, meta row and
// a circular open affordance, with a fixed height so truncation never reflows.
//
// The whole card is clickable via the "stretched link" pattern: the title is a
// real anchor whose ::after covers the card. That keeps native link behaviour
// (middle-click, cmd-click, focus, screen-reader semantics) without wrapping
// the favorite button in an anchor, which would be invalid HTML.
export function DashboardCard({ dashboard, onOpen, onToggleFavorite }: Props) {
  const styles = useStyles2(getStyles);

  const handleOpen = (event: MouseEvent) => {
    // Analytix: let the browser handle modified clicks (new tab, new window).
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    onOpen(dashboard);
  };

  const favoriteLabel = dashboard.favorite
    ? t('analytix.home.card.unfavorite', 'Remove "{{title}}" from favorites', { title: dashboard.title })
    : t('analytix.home.card.favorite', 'Add "{{title}}" to favorites', { title: dashboard.title });

  return (
    <article className={styles.card}>
      <div className={styles.icon}>{getDashboardIcon(dashboard.title)}</div>

      <div className={styles.copy}>
        <h3 className={styles.title}>
          <a className={styles.link} href={dashboard.url} title={dashboard.title} onClick={handleOpen}>
            {dashboard.title}
          </a>
        </h3>
        <p className={styles.description} title={dashboard.description}>
          {dashboard.description}
        </p>
      </div>

      <button
        type="button"
        className={dashboard.favorite ? styles.favoriteActive : styles.favorite}
        aria-label={favoriteLabel}
        aria-pressed={dashboard.favorite}
        onClick={() => onToggleFavorite(dashboard)}
      >
        <FavoriteIcon filled={dashboard.favorite} />
      </button>

      <div className={styles.meta}>{dashboard.folderName && <span className={styles.folder}>{dashboard.folderName}</span>}</div>

      <span className={styles.open} data-analytix-open="" aria-hidden={true}>
        <OpenArrowIcon />
      </span>
    </article>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  card: css({
    position: 'relative',
    height: 126,
    padding: '16px 12px 8px 14px',
    display: 'grid',
    gridTemplateColumns: '72px minmax(0, 1fr) 36px',
    gridTemplateRows: '1fr 30px',
    border: `1px solid ${analytix.border}`,
    // eslint-disable-next-line @grafana/no-border-radius-literal -- Analytix: exact radius from the approved design (tokens.css --anx-radius-card)
    borderRadius: analytix.radiusCard,
    // Analytix: cards sit one step above the panel surface so they read as
    // cards. background.primary is the same colour as the page canvas in the
    // dark theme, which would make them look like holes in the panel.
    background: theme.colors.background.elevated,

    [theme.transitions.handleMotion('no-preference')]: {
      transition: theme.transitions.create(['transform', 'border-color', 'background'], { duration: 160 }),
    },

    '&:hover': {
      transform: 'translateY(-2px)',
      borderColor: analytix.borderHover,
    },
    '&:hover [data-analytix-open]': {
      borderColor: analytix.green,
      color: analytix.greenBright,
    },
    // Analytix: the stretched link is the focus target, so raise the ring to the card
    '&:focus-within': {
      boxShadow: analytix.focusRing,
    },

    [theme.breakpoints.down('md')]: {
      height: 122,
    },
    [theme.breakpoints.down('sm')]: {
      gridTemplateColumns: '62px minmax(0, 1fr) 34px',
      paddingLeft: 11,
    },
  }),
  icon: css({
    gridRow: 1,
    width: 56,
    height: 56,
    display: 'grid',
    placeItems: 'center',
    border: '1px solid #216d2b',
    // eslint-disable-next-line @grafana/no-border-radius-literal -- Analytix: exact radius from the approved design
    borderRadius: analytix.radiusCard,
    color: analytix.greenBright,
    background: 'rgb(18 55 24 / 25%)',

    '& svg': { width: 38, height: 38 },

    [theme.breakpoints.down('sm')]: {
      width: 50,
      height: 50,
      '& svg': { width: 34, height: 34 },
    },
  }),
  copy: css({
    minWidth: 0,
    padding: '7px 6px 0 4px',
  }),
  title: css({
    margin: '0 0 7px',
    overflow: 'hidden',
    fontSize: 17,
    lineHeight: 1.25,
    fontWeight: 500,
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',

    [theme.breakpoints.down('sm')]: {
      fontSize: 15,
    },
  }),
  link: css({
    color: analytix.text,
    outline: 0,

    // Analytix: stretch the anchor over the whole card so the card is clickable
    '&::after': {
      content: '""',
      position: 'absolute',
      inset: 0,
    },
  }),
  description: css({
    margin: 0,
    overflow: 'hidden',
    color: analytix.textDim,
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  }),
  favorite: css({
    position: 'absolute',
    zIndex: 1,
    top: 12,
    right: 12,
    width: 20,
    height: 20,
    padding: 0,
    border: 0,
    background: 'transparent',
    color: '#777',
    cursor: 'pointer',
    '& svg': { width: '100%', height: '100%' },
    '&:hover': { color: analytix.favorite },
    '&:focus-visible': { outline: 0, boxShadow: analytix.focusRing },
  }),
  favoriteActive: css({
    position: 'absolute',
    zIndex: 1,
    top: 12,
    right: 12,
    width: 20,
    height: 20,
    padding: 0,
    border: 0,
    background: 'transparent',
    color: analytix.favorite,
    cursor: 'pointer',
    '& svg': { width: '100%', height: '100%' },
    '&:focus-visible': { outline: 0, boxShadow: analytix.focusRing },
  }),
  meta: css({
    gridColumn: '1 / 3',
    alignSelf: 'end',
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    minWidth: 0,
    color: analytix.textFaint,
    fontSize: 12,
  }),
  folder: css({
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  }),
  open: css({
    gridColumn: 3,
    gridRow: 2,
    alignSelf: 'end',
    // Analytix: right-align inside the column so the arrow's right edge lines
    // up with the favorite star above it (both sit on the card's 12px inset)
    justifySelf: 'end',
    width: 30,
    height: 30,
    display: 'grid',
    placeItems: 'center',
    border: '1px solid #484d4e',
    borderRadius: theme.shape.radius.circle,
    color: analytix.text,
    '& svg': { width: 18, height: 18 },

    [theme.transitions.handleMotion('no-preference')]: {
      transition: theme.transitions.create(['border-color', 'color'], { duration: 160 }),
    },
  }),
});
