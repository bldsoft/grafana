// Analytix: provider scope of the alerts page. The organisation attribute
// providerIds (set by a server admin, see pkg/services/org/model.go) bounds
// what the page reads: `*` = every provider, a PID list, '' = none. The
// operator may narrow it further with their own PID list, never widen it.

import { sanitizePids } from './sql';

/** `null` = all providers, `[]` = none, otherwise the PID list. */
export type ProviderScope = string[] | null;

export function parseProviderScope(providerIds: string): ProviderScope {
  const value = providerIds.trim();
  if (value === '*') {
    return null;
  }
  return sanitizePids(value.split(','));
}

/** Intersects the org scope with the PIDs typed into the page filter. */
export function effectiveScope(orgScope: ProviderScope, filter: string): ProviderScope {
  const wanted = sanitizePids(filter.split(','));
  if (!wanted.length) {
    return orgScope;
  }
  if (orgScope === null) {
    return wanted;
  }
  return wanted.filter((pid) => orgScope.includes(pid));
}
