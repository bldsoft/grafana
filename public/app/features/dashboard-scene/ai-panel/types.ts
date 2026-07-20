/**
 * AI panel generator — shared types.
 *
 * The feature lets a user describe a panel in natural language; an LLM turns the
 * request into a ClickHouse SQL query plus a visualization type, and we build a
 * panel from the result. See {@link ./GenPanelButton.tsx} for the entry point.
 */

/** Panel plugin ids the generator is allowed to produce. */
export const SUPPORTED_PANEL_TYPES = ['timeseries', 'piechart', 'table', 'stat', 'barchart'] as const;

export type SupportedPanelType = (typeof SUPPORTED_PANEL_TYPES)[number];

/** The structured result we expect back from the LLM. */
export interface GeneratedPanelSpec {
  panelType: SupportedPanelType;
  title: string;
  rawSql: string;
  /** Optional Grafana time expression, e.g. "now-30d". */
  timeFrom?: string;
  /** Optional Grafana time expression, e.g. "now". */
  timeTo?: string;
}
