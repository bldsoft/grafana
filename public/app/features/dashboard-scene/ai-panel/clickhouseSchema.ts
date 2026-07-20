import { lastValueFrom } from 'rxjs';

import { CoreApp, DataFrame, DataQuery, DataQueryRequest, DataSourceRef, getDefaultTimeRange } from '@grafana/data';
import { DataSourceWithBackend, getDataSourceSrv } from '@grafana/runtime';

/** A raw SQL query understood by both the official and community ClickHouse plugins. */
interface SqlQuery extends DataQuery {
  rawSql: string;
  query: string;
}

/**
 * Reads the ClickHouse table/column layout so we can give the LLM a real schema
 * to write SQL against, instead of letting it guess table and column names.
 */
const SCHEMA_SQL =
  'SELECT table, name, type FROM system.columns ' +
  "WHERE database = currentDatabase() AND table NOT LIKE '.%' " +
  'ORDER BY table, position';

/**
 * Run the schema query against the given datasource and return a compact,
 * prompt-friendly string like:
 *   events(ts DateTime, user_id UInt64, category String)
 *   orders(id UInt64, amount Float64, created_at DateTime)
 *
 * Returns an empty string when the schema can't be read; the caller decides how
 * to degrade.
 */
export async function fetchClickhouseSchema(datasource: DataSourceRef): Promise<string> {
  const ds = await getDataSourceSrv().get(datasource);

  if (!(ds instanceof DataSourceWithBackend)) {
    throw new Error('The selected datasource does not support backend queries.');
  }

  const request: DataQueryRequest<SqlQuery> = {
    requestId: 'ai-panel-schema',
    interval: '1h',
    intervalMs: 3600000,
    range: getDefaultTimeRange(),
    scopedVars: {},
    timezone: 'browser',
    app: CoreApp.Dashboard,
    startTime: 0,
    targets: [{ refId: 'A', datasource, rawSql: SCHEMA_SQL, query: SCHEMA_SQL }],
  };

  const result = await lastValueFrom(ds.query(request));
  const frame: DataFrame | undefined = result.data?.[0];

  if (!frame || frame.length === 0) {
    return '';
  }

  return formatSchema(frame);
}

function formatSchema(frame: DataFrame): string {
  const tableField = frame.fields.find((f) => f.name === 'table');
  const nameField = frame.fields.find((f) => f.name === 'name');
  const typeField = frame.fields.find((f) => f.name === 'type');

  if (!tableField || !nameField || !typeField) {
    return '';
  }

  const tables = new Map<string, string[]>();

  for (let i = 0; i < frame.length; i++) {
    const table = String(tableField.values[i]);
    const column = `${nameField.values[i]} ${typeField.values[i]}`;
    const columns = tables.get(table) ?? [];
    columns.push(column);
    tables.set(table, columns);
  }

  return Array.from(tables.entries())
    .map(([table, columns]) => `${table}(${columns.join(', ')})`)
    .join('\n');
}
