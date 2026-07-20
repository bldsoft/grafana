// Analytix: card descriptions for the home-page dashboard catalog.
//
// NOTE: the Grafana search index does NOT return a dashboard's `description`
// field (see app/features/search/service/unified.ts - hits carry name, folder,
// tags, uid and url only). Reading real descriptions would mean one
// /api/dashboards/uid/:uid request per card, which is too expensive for the
// home page. Until descriptions are added to the search index, the nine
// approved dashboards get their copy from this map and everything else falls
// back to its folder name.
const descriptionsByTitle: Record<string, string> = {
  'search info': 'Analyze search behavior',
  'content info': 'Monitor content performance',
  'stream quality info': 'Track playback quality',
  'organisations info': 'Review organisation activity',
  'providers info': 'Monitor provider performance',
  'user info': 'Understand user behavior',
  'device info': 'Analyze device usage',
  'cdn qos': 'Monitor delivery quality',
  'feature adoption rate': 'Track product adoption',
};

/**
 * Resolves the one-line description shown on a dashboard card.
 * Returns the approved copy when the title is known, otherwise the folder name.
 */
export function getDashboardDescription(title: string, folderName?: string): string {
  const key = title.trim().toLowerCase().replace(/\s+/g, ' ');
  return descriptionsByTitle[key] ?? folderName ?? '';
}

/** True when the description came from the approved map rather than the folder. */
export function hasApprovedDescription(title: string): boolean {
  const key = title.trim().toLowerCase().replace(/\s+/g, ' ');
  return key in descriptionsByTitle;
}
