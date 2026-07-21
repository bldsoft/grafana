import { css } from '@emotion/css';
import { useMemo, useState } from 'react';

import { GrafanaTheme2 } from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import { reportInteraction } from '@grafana/runtime';
import { Spinner, useStyles2 } from '@grafana/ui';
import { useStarItem } from 'app/features/stars/hooks';

import { DashboardCard } from './DashboardCard';
import { FavoriteIcon, RecentIcon, SearchIcon } from './analytixIcons';
import { analytix } from './analytixTokens';
import { AnalytixDashboard, STAR_GROUP, STAR_KIND, useAnalytixDashboards } from './useAnalytixDashboards';

type Filter = 'all' | 'favorites' | 'recent';

interface Props {
  onOpen: (dashboard: AnalytixDashboard) => void;
}

// Analytix: "Your dashboards" block from the approved home-page design.
// Filters, search and the responsive card grid follow COMPONENT_SPEC.md.
export function DashboardCatalog({ onOpen }: Props) {
  const styles = useStyles2(getStyles);
  const { dashboards, loading, error } = useAnalytixDashboards();
  const starItem = useStarItem(STAR_GROUP, STAR_KIND);

  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  // Analytix: starred state comes from RTK Query, but the mutation is optimistic
  // here so the star fills instantly instead of waiting for a refetch.
  const [pendingFavorites, setPendingFavorites] = useState<Record<string, boolean>>({});

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return dashboards
      .map((dashboard) => ({
        ...dashboard,
        favorite: pendingFavorites[dashboard.uid] ?? dashboard.favorite,
      }))
      .filter((dashboard) => {
        const matchesQuery =
          !needle || `${dashboard.title} ${dashboard.description}`.toLowerCase().includes(needle);
        const matchesFilter =
          filter === 'all' ||
          (filter === 'favorites' && dashboard.favorite) ||
          (filter === 'recent' && dashboard.recent);
        return matchesQuery && matchesFilter;
      });
  }, [dashboards, query, filter, pendingFavorites]);

  const handleFilter = (next: Filter) => {
    setFilter(next);
    reportInteraction('analytix_home_dashboard_filter_changed', { filter: next });
  };

  const handleToggleFavorite = async (dashboard: AnalytixDashboard) => {
    const next = !dashboard.favorite;
    setPendingFavorites((current) => ({ ...current, [dashboard.uid]: next }));
    reportInteraction('analytix_home_dashboard_favorite_changed', { favorite: next });

    try {
      await starItem({ id: dashboard.uid, title: dashboard.title }, next);
    } catch (err) {
      // Analytix: roll the optimistic star back if persistence failed.
      setPendingFavorites((current) => ({ ...current, [dashboard.uid]: !next }));
      console.error('Failed to update dashboard favorite', err);
    }
  };

  const filterButton = (value: Filter, label: string, icon?: React.ReactNode) => (
    <button
      type="button"
      className={filter === value ? styles.filterActive : styles.filter}
      aria-pressed={filter === value}
      onClick={() => handleFilter(value)}
    >
      {icon && <span className={styles.filterIcon}>{icon}</span>}
      <span className={styles.filterLabel}>{label}</span>
    </button>
  );

  return (
    <section className={styles.panel} aria-labelledby="analytix-dashboards-title">
      <h2 id="analytix-dashboards-title" className={styles.heading}>
        <Trans i18nKey="analytix.home.catalog.title">Your dashboards</Trans>
      </h2>

      <div className={styles.toolbar}>
        <div className={styles.filters} role="group" aria-label={t('analytix.home.catalog.filters', 'Filter dashboards')}>
          {filterButton('all', t('analytix.home.catalog.all', 'All'))}
          {filterButton('favorites', t('analytix.home.catalog.favorites', 'Favorites'), <FavoriteIcon filled={false} />)}
          {filterButton('recent', t('analytix.home.catalog.recent', 'Recently viewed'), <RecentIcon />)}
        </div>

        <label className={styles.search}>
          <span className={styles.searchIcon}>
            <SearchIcon />
          </span>
          <span className={styles.visuallyHidden}>
            <Trans i18nKey="analytix.home.catalog.search-label">Search dashboards</Trans>
          </span>
          <input
            type="search"
            className={styles.searchInput}
            placeholder={t('analytix.home.catalog.search', 'Search dashboards')}
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      </div>

      {loading && (
        <div className={styles.centered}>
          <Spinner />
        </div>
      )}

      {!loading && error && (
        <p className={styles.centered}>
          <Trans i18nKey="analytix.home.catalog.error">Dashboards couldn’t be loaded.</Trans>
        </p>
      )}

      {!loading && !error && visible.length > 0 && (
        <div className={styles.grid}>
          {visible.map((dashboard) => (
            <DashboardCard
              key={dashboard.uid}
              dashboard={dashboard}
              onOpen={onOpen}
              onToggleFavorite={handleToggleFavorite}
            />
          ))}
        </div>
      )}

      {!loading && !error && visible.length === 0 && (
        <p className={styles.centered}>
          <Trans i18nKey="analytix.home.catalog.empty">No dashboards match your search.</Trans>
        </p>
      )}

      <p className={styles.visuallyHidden} role="status" aria-live="polite">
        {t('analytix.home.catalog.count', '{{count}} dashboards shown.', { count: visible.length })}
      </p>
    </section>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  panel: css({
    minHeight: 530,
    padding: '12px 16px 16px',
    border: `1px solid ${analytix.border}`,
    borderRadius: analytix.radiusPanel,
    // Analytix: same grey surface as the welcome panel (see WelcomePanel)
    background: theme.colors.background.secondary,

    [theme.breakpoints.down('sm')]: {
      paddingInline: 10,
    },
  }),
  heading: css({
    margin: '0 0 12px',
    fontSize: 18,
    lineHeight: 1.4,
    fontWeight: 500,
    color: analytix.text,
  }),
  toolbar: css({
    marginBottom: 16,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 16,

    [theme.breakpoints.down('md')]: {
      flexDirection: 'column',
      alignItems: 'stretch',
    },
  }),
  filters: css({
    display: 'flex',
    gap: 10,

    [theme.breakpoints.down('sm')]: {
      width: '100%',
    },
  }),
  filter: css({
    minHeight: 35,
    padding: '0 13px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    border: `1px solid ${analytix.borderControl}`,
    borderRadius: analytix.radiusControl,
    background: '#131617',
    color: analytix.textMuted,
    font: 'inherit',
    cursor: 'pointer',
    '&:hover': { color: '#fff' },
    '&:focus-visible': { outline: 0, boxShadow: analytix.focusRing },

    [theme.breakpoints.down('sm')]: {
      flex: 1,
      paddingInline: 7,
      justifyContent: 'center',
    },
  }),
  filterActive: css({
    minHeight: 35,
    padding: '0 13px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    border: '1px solid #2e7b38',
    borderRadius: analytix.radiusControl,
    background: analytix.greenDark,
    color: '#fff',
    font: 'inherit',
    cursor: 'pointer',
    '&:focus-visible': { outline: 0, boxShadow: analytix.focusRing },

    [theme.breakpoints.down('sm')]: {
      flex: 1,
      paddingInline: 7,
      justifyContent: 'center',
    },
  }),
  filterIcon: css({
    display: 'inline-flex',
    width: 15,
    height: 15,
    '& svg': { width: '100%', height: '100%' },
  }),
  filterLabel: css({
    // Analytix: labels collapse to icons on the narrowest layout
    [theme.breakpoints.down('sm')]: {
      display: 'none',
    },
  }),
  search: css({
    width: 310,
    height: 35,
    padding: '0 12px',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    border: `1px solid ${analytix.borderControl}`,
    borderRadius: analytix.radiusControl,
    background: analytix.controlSunken,
    color: analytix.textMuted,
    '&:focus-within': { outline: 0, boxShadow: analytix.focusRing },

    [theme.breakpoints.down('md')]: {
      width: '100%',
    },
  }),
  searchIcon: css({
    display: 'inline-flex',
    flexShrink: 0,
    width: 18,
    height: 18,
    '& svg': { width: '100%', height: '100%' },
  }),
  searchInput: css({
    width: '100%',
    minWidth: 0,
    border: 0,
    outline: 0,
    background: 'transparent',
    color: '#fff',
    font: 'inherit',
    '&::placeholder': { color: '#7f8587' },
  }),
  grid: css({
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: '12px 14px',

    [theme.breakpoints.down('xl')]: {
      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    },
    [theme.breakpoints.down('md')]: {
      gridTemplateColumns: '1fr',
    },
  }),
  centered: css({
    padding: '70px 20px',
    textAlign: 'center',
    color: '#969b9d',
  }),
  visuallyHidden: css({
    position: 'absolute',
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    border: 0,
  }),
});
