// Analytix: AI Insider Alerts - what an error code means, in words. The
// detector keys an error as `<slot 10>/<slot 11>` (HTTP code / player code);
// the ClickHouse dictionary stat.error_dictionary_dict describes the codes per
// platform (its source table stat.error_dictionary_dst is read when the
// dictionary is not there). It is small: read once per datasource when a view
// first needs it, cached for the page.

import { useContext, useEffect, useState } from 'react';

import { DataSourceRef } from '@grafana/data';

import { AlertsDatasourceContext } from './CdnCheck';
import { str } from './coerce';
import { queryRows } from './query';
import { settingsClause } from './sql';

const SETTINGS = settingsClause('ai-insider:alerts-errors', { maxExecutionSec: 30, maxResultRows: 50_000 });

/** Code (normalised) → description per platform (lower case), '' for "any platform". */
export type ErrorDictionary = Map<string, Map<string, string>>;

export const ERROR_DICTIONARY = 'stat.error_dictionary_dict';
const ERROR_DICTIONARY_TABLE = 'stat.error_dictionary_dst';

export function errorDictionarySql(from: string = ERROR_DICTIONARY): string {
  // No alias may repeat a column name: ClickHouse would put the aggregate
  // `any(description)` into `WHERE description != ''` (ILLEGAL_AGGREGATION).
  return `SELECT
    lower(toString(platform)) AS err_platform,
    trim(replace(toString(error_code), '-', '')) AS err_code,
    any(toString(description)) AS meaning
FROM ${from}
WHERE toString(description) != ''
GROUP BY err_platform, err_code
${SETTINGS}`;
}

/** The error key `403/1001` as support reads it: `403 / 1001`, `-` slots dropped. */
export function errorKeyText(key: string): string {
  return (
    key
      .split('/')
      .filter((c) => c && c !== '-')
      .join(' / ') || '—'
  );
}

/** The dictionary and the stream disagree about leading dashes: compare without them. */
export function normaliseCode(code: string): string {
  return code.replace(/-/g, '').trim();
}

export function buildErrorDictionary(rows: Array<Record<string, unknown>>): ErrorDictionary {
  const dict: ErrorDictionary = new Map();
  for (const r of rows) {
    const code = normaliseCode(str(r.err_code));
    const description = str(r.meaning).trim();
    if (!code || !description) {
      continue;
    }
    const byPlatform = dict.get(code) ?? new Map<string, string>();
    byPlatform.set(str(r.err_platform).toLowerCase(), description);
    dict.set(code, byPlatform);
  }
  return dict;
}

function lookup(dict: ErrorDictionary, code: string, platform: string): string | undefined {
  const byPlatform = dict.get(normaliseCode(code));
  if (!byPlatform) {
    return undefined;
  }
  // The viewer's own platform first, then the "any platform" wording. A code
  // means different things on different players (4001 is a decoder failure on
  // Android and bad DASH XML on SmartTV): another platform's words are used
  // only when every platform says the same.
  const own = byPlatform.get(platform.toLowerCase()) ?? byPlatform.get('');
  if (own) {
    return own;
  }
  const said = new Set(byPlatform.values());
  return said.size === 1 ? said.values().next().value : undefined;
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

/** The incident's codes, most viewers first, each with its words (read on the incident's top platform). */
export function describeCodes(
  dict: ErrorDictionary | undefined,
  codes: Record<string, number>,
  platforms: Record<string, number>,
  limit = 4
): Array<{ key: string; count: number; description?: string }> {
  let platform = '';
  let best = -1;
  for (const [p, n] of Object.entries(platforms)) {
    if (n > best) {
      platform = p;
      best = n;
    }
  }
  return Object.entries(codes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count, description: describeError(dict, key, platform) }));
}

const cache = new Map<string, Promise<ErrorDictionary>>();

function load(datasource: DataSourceRef): Promise<ErrorDictionary> {
  const key = datasource.uid ?? '';
  let hit = cache.get(key);
  if (!hit) {
    hit = queryRows(datasource, errorDictionarySql(), { timeoutMs: 35_000 })
      .catch(() => queryRows(datasource, errorDictionarySql(ERROR_DICTIONARY_TABLE), { timeoutMs: 35_000 }))
      .then(buildErrorDictionary);
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
