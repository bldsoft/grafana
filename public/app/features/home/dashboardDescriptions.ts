// Analytix: fallback card descriptions for the home-page dashboard catalog.
//
// The dashboard's own `description` always wins (see useAnalytixDashboards).
// This map only fills in the nine approved dashboards when they have no
// description set, so the home page still matches the approved design on a
// fresh install. Anything else falls back to its folder name.
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
