import { BASE_URL as v0alphaBaseURL } from '@grafana/api-clients/rtkq/dashboard/v0alpha1';
import { getBackendSrv } from '@grafana/runtime';

interface SearchHitWithDescription {
  name: string;
  description?: string;
}

interface DescriptionSearchResponse {
  hits?: SearchHitWithDescription[];
}

// Analytix: the legacy SQL search API (the default searcher unless the
// `unifiedStorageSearchUI` feature toggle is on) does not return a dashboard's
// description - see app/features/search/service/sql.ts, whose frame carries
// only kind/name/uid/url/tags/location.
//
// The app-platform search endpoint DOES return it (DashboardHit.Description),
// so we ask it once for the descriptions and merge them in. When that endpoint
// is unavailable - unified storage not running, older backend, no permission -
// this resolves to an empty map and the caller falls back to its own copy.
export async function fetchDashboardDescriptions(limit: number): Promise<Record<string, string>> {
  try {
    const response = await getBackendSrv().get<DescriptionSearchResponse>(
      `${v0alphaBaseURL}/search?query=*&type=dashboard&limit=${limit}`,
      undefined,
      undefined,
      // Analytix: this is a best-effort enrichment - keep the failure quiet so a
      // backend without unified search does not spam the user with error toasts.
      { showErrorAlert: false, showSuccessAlert: false }
    );

    const descriptions: Record<string, string> = {};
    for (const hit of response?.hits ?? []) {
      const description = hit.description?.trim();
      if (hit.name && description) {
        descriptions[hit.name] = description;
      }
    }
    return descriptions;
  } catch (error) {
    return {};
  }
}
