/**
 * AI panel generator — shared types.
 *
 * The feature lets a user describe a panel in natural language; an LLM turns the
 * request into a ClickHouse SQL query plus a visualization type, and we build a
 * panel from the result. See {@link ./GenPanelButton.tsx} for the entry point.
 */

/**
 * Panel plugin ids the generator is allowed to produce. Kept in sync with the
 * service (services/panel-spec.js in analytix-ai-insider) — the two lists must
 * match or specs get dropped by normalizeResult. Deliberately excluded core
 * panels: geomap (no geo mapping config from a bare query), candlestick
 * (finance-specific), logs/traces/nodegraph/flamegraph (need typed non-SQL
 * frames), canvas/text/news/dashlist/alertlist (not data charts).
 */
export const SUPPORTED_PANEL_TYPES = [
  'timeseries',
  'piechart',
  'table',
  'stat',
  'barchart',
  'gauge',
  'bargauge',
  'histogram',
  'heatmap',
  'state-timeline',
  'status-history',
  'trend',
  'xychart',
] as const;

export type SupportedPanelType = (typeof SUPPORTED_PANEL_TYPES)[number];

/** Column types of a static result frame (GA4 panels). */
export type StaticFieldType = 'time' | 'number' | 'string';

/**
 * A result carried inside the spec itself: GA4 app-behavior answers are run by
 * the service (there is no GA4 datasource to re-run them), so the panel shows
 * this frame as-is. Time values are epoch millis.
 */
export interface StaticPanelData {
  fields: Array<{ name: string; type: StaticFieldType }>;
  rows: Array<Array<string | number | null>>;
}

/**
 * The structured result we expect back from the LLM. Mirrors
 * services/panel-spec.js in analytix-ai-insider — keep the two in sync.
 */
export interface GeneratedPanelSpec {
  panelType: SupportedPanelType;
  title: string;
  /** ClickHouse SQL re-run through the user's datasource; '' for GA4 panels. */
  rawSql: string;
  /** Optional Grafana time expression, e.g. "now-30d". */
  timeFrom?: string;
  /** Optional Grafana time expression, e.g. "now". */
  timeTo?: string;
  /** Data source of the panel: ClickHouse SQL (default) or a GA4 result. */
  source?: 'clickhouse' | 'ga4';
  /** GA4 only: the result frame. */
  data?: StaticPanelData;
}
