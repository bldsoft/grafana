// Analytix: AI Insider Alerts - what an error code means, in words. The
// detector keys an error as `<slot 10>/<slot 11>` (HTTP code / player code);
// stat.error_dictionary_dst describes the codes per platform. The dictionary
// is small: read once per datasource when a table first needs it, cached for
// the page.

import { useContext, useEffect, useState } from 'react';

import { DataSourceRef } from '@grafana/data';

import { AlertsDatasourceContext } from './CdnCheck';
import { str } from './coerce';
import { queryRows } from './query';
import { settingsClause } from './sql';

const SETTINGS = settingsClause('ai-insider:alerts-errors', { maxExecutionSec: 30, maxResultRows: 50_000 });

/** Code (normalised) → description per platform (lower case), '' for "any platform". */
export type ErrorDictionary = Map<string, Map<string, string>>;

export function errorDictionarySql(): string {
  return `SELECT
    lower(toString(platform)) AS platform,
    trim(replace(toString(error_code), '-', '')) AS code,
    any(toString(description)) AS description
FROM stat.error_dictionary_dst
WHERE description != ''
GROUP BY platform, code
${SETTINGS}`;
}

/** The dictionary and the stream disagree about leading dashes: compare without them. */
export function normaliseCode(code: string): string {
  return code.replace(/-/g, '').trim();
}

export function buildErrorDictionary(rows: Array<Record<string, unknown>>): ErrorDictionary {
  const dict: ErrorDictionary = new Map();
  for (const r of rows) {
    const code = normaliseCode(str(r.code));
    const description = str(r.description).trim();
    if (!code || !description) {
      continue;
    }
    const byPlatform = dict.get(code) ?? new Map<string, string>();
    byPlatform.set(str(r.platform).toLowerCase(), description);
    dict.set(code, byPlatform);
  }
  return dict;
}

function lookup(dict: ErrorDictionary, code: string, platform: string): string | undefined {
  const byPlatform = dict.get(normaliseCode(code));
  if (!byPlatform) {
    return undefined;
  }
  // The viewer's own platform first, then any platform's wording.
  return byPlatform.get(platform.toLowerCase()) ?? byPlatform.get('') ?? byPlatform.values().next().value;
}

/**
 * The words for an error key `<http>/<player>` on a platform: the player
 * code's description, else the HTTP code's; undefined when neither is known.
 */
export function describeError(dict: ErrorDictionary | undefined, key: string, platform: string): string | undefined {
  if (!dict || !key) {
    return undefined;
  }
  const [http = '', player = ''] = key.split('/');
  const parts = [player, http].filter((c) => c && c !== '-');
  for (const code of parts) {
    const text = lookup(dict, code, platform);
    if (text) {
      return text;
    }
  }
  return undefined;
}

const cache = new Map<string, Promise<ErrorDictionary>>();

function load(datasource: DataSourceRef): Promise<ErrorDictionary> {
  const key = datasource.uid ?? '';
  let hit = cache.get(key);
  if (!hit) {
    hit = queryRows(datasource, errorDictionarySql(), { timeoutMs: 35_000 }).then(buildErrorDictionary);
    // A failed read is tried again the next time a table needs it.
    hit.catch(() => cache.delete(key));
    cache.set(key, hit);
  }
  return hit;
}

/** The dictionary of the run's datasource; undefined while loading or when it cannot be read. */
export function useErrorDictionary(): ErrorDictionary | undefined {
  const datasource = useContext(AlertsDatasourceContext);
  const [dict, setDict] = useState<ErrorDictionary>();
  useEffect(() => {
    if (!datasource) {
      return undefined;
    }
    let live = true;
    load(datasource)
      .then((d) => live && setDict(d))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [datasource]);
  return dict;
}
