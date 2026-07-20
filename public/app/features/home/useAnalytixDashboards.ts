import { useMemo } from 'react';
import { useAsync } from 'react-use';

import impressionSrv from 'app/core/services/impression_srv';
import { getGrafanaSearcher } from 'app/features/search/service/searcher';
import { LocationInfo } from 'app/features/search/service/types';
import { useStarredItems } from 'app/features/stars/hooks';

import { getDashboardDescription } from './dashboardDescriptions';

// Analytix: the home catalog shows the client's full dashboard set, which is
// small by design. This cap keeps a misconfigured tenant from rendering
// thousands of cards.
const MAX_DASHBOARDS = 200;

export const STAR_GROUP = 'dashboard.grafana.app';
export const STAR_KIND = 'Dashboard';

export interface AnalytixDashboard {
  uid: string;
  title: string;
  description: string;
  url: string;
  folderName?: string;
  favorite: boolean;
  recent: boolean;
}

interface Result {
  dashboards: AnalytixDashboard[];
  loading: boolean;
  error?: Error;
}

/**
 * Loads every dashboard the current user can see, annotated with favorite
 * (starred) and recently-viewed state for the home-page catalog.
 */
export function useAnalytixDashboards(): Result {
  const { data: starredUids, isLoading: starsLoading } = useStarredItems(STAR_GROUP, STAR_KIND);

  const {
    value,
    loading: searchLoading,
    error,
  } = useAsync(async () => {
    const [response, recentUids, locationInfo] = await Promise.all([
      getGrafanaSearcher().search({ kind: ['dashboard'], limit: MAX_DASHBOARDS }),
      impressionSrv.getDashboardOpened().catch((): string[] => []),
      getGrafanaSearcher()
        .getLocationInfo()
        .catch((): Record<string, LocationInfo> => ({})),
    ]);

    return { hits: response.view.toArray(), recentUids, locationInfo };
  }, []);

  const dashboards = useMemo<AnalytixDashboard[]>(() => {
    if (!value) {
      return [];
    }

    const { hits, recentUids, locationInfo } = value;
    const starred = new Set(starredUids ?? []);
    const recent = new Set(recentUids);

    // Analytix: recently-opened order drives the "Recently viewed" filter, so
    // keep it available for sorting within that filter.
    const recentOrder = new Map(recentUids.map((uid, index) => [uid, index]));

    return hits
      .filter((hit) => !hit.isDeleted)
      .map((hit) => {
        const folderName = locationInfo[hit.location]?.name;
        return {
          uid: hit.uid,
          title: hit.name,
          description: getDashboardDescription(hit.name, folderName),
          url: hit.url,
          folderName,
          favorite: starred.has(hit.uid),
          recent: recent.has(hit.uid),
        };
      })
      .sort((a, b) => {
        const aOrder = recentOrder.get(a.uid) ?? Number.MAX_SAFE_INTEGER;
        const bOrder = recentOrder.get(b.uid) ?? Number.MAX_SAFE_INTEGER;
        if (aOrder !== bOrder) {
          return aOrder - bOrder;
        }
        // eslint-disable-next-line no-restricted-syntax -- Analytix: the catalog is capped at MAX_DASHBOARDS (200), so localeCompare is fine here
        return a.title.localeCompare(b.title);
      });
  }, [value, starredUids]);

  return {
    dashboards,
    loading: searchLoading || starsLoading,
    error: error instanceof Error ? error : undefined,
  };
}
