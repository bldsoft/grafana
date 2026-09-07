import {
  DataFrame,
  DataSourceRef,
  DataTransformerConfig,
  FieldColorModeId,
  FieldConfigSource,
  FieldType,
  LoadingState,
  PanelData,
} from '@grafana/data';
import { SceneDataTransformer, SceneQueryRunner, VizPanel } from '@grafana/scenes';

import { isSafeBridgeSql, rawSqlQuery } from './datasourceQuery';
import { GeneratedPanelSpec, SupportedPanelType } from './types';

/**
 * Analytix: per-panel-type visual defaults so generated charts land in the
 * dashboard look — flat pastel-blue bars, thin linear lines, pale-green stat
 * values on dark — instead of bare plugin defaults.
 */
// Soft blue of the "TOP 10 ..." bar rows on the Home dashboard.
const ANALYTIX_BLUE = '#8ab8ff';
// Pale green of the big stat values ("98.0 k") on the Home dashboard.
const ANALYTIX_GREEN_SOFT = '#a9e0b0';
// Fixed Y-axis width (px): fits up to 9-digit tick labels without clipping.
const AXIS_LABEL_WIDTH = 70;
// Barchart X-tick labels: default slant for long categorical label sets.
const BARCHART_ROTATED_TICK_ANGLE = -45;
// Ellipsis cap for ROTATED labels. Without an explicit option the barchart
// panel never shortens X labels at all: BarChartPanel recomputes an "auto"
// cap from the panel height, but only uses it as a memo dependency — the
// axis renderer reads the RAW option (prepConfig → formatShortValue), which
// is undefined by default. So a 21-char channel name rendered full-length
// and was clipped by the canvas edge mid-word, with no "..." at all. An
// explicit cap makes the ellipsis deterministic. Derivation for the chat
// card at -45°: ~260px of plot height (320 minus panel chrome), half of it
// is the rotated-label budget → 130 / sin(45°) ≈ 184px ≈ 19 worst-case
// chars, minus 3 for the "..." suffix. The same raw option is applied by
// the panel at ANY rotation, so applyDynamicTickRotation clears it when it
// switches to horizontal. The tooltip always shows the full value.
const BARCHART_ROTATED_LABEL_MAX_CHARS = 16;
// Approximate axis-font character width (px) for the fits-horizontally check.
const TICK_CHAR_PX = 8;
// Conservative plot width (px): the chat card is normally wider, so a set that
// fits at this width fits everywhere the panel is rendered.
const ASSUMED_PLOT_WIDTH = 600;
// Default unit for every numeric field outside tables: the generated SQL
// carries no units, and raw magnitudes (watch time in seconds, 1e10 for a
// day) produce 11-digit axis labels that overflow AXIS_LABEL_WIDTH and render
// as "0000000000" (seen 2026-09-07). `short` abbreviates to "10.0 Bil" and
// matches the "98.0 k" stat values of the Home dashboard. Tables keep exact
// numbers; the CSV export strips the unit again (exportPanel.ts).
const DEFAULT_NUMBER_UNIT = 'short';
// Panels whose numbers stay unformatted: a table wants exact values, and the
// heatmap formats its own axes from its options rather than the field unit.
const UNFORMATTED_PANEL_TYPES: readonly SupportedPanelType[] = ['table', 'heatmap'];

function fieldConfigFor(panelType: SupportedPanelType): FieldConfigSource {
  switch (panelType) {
    case 'timeseries':
      return {
        defaults: {
          color: { mode: FieldColorModeId.PaletteClassic },
          custom: {
            drawStyle: 'line',
            lineInterpolation: 'linear',
            lineWidth: 1,
            fillOpacity: 0,
            gradientMode: 'none',
            showPoints: 'never',
            spanNulls: true,
            pointSize: 4,
            // Auto axis sizing under-measures inside the chat card and clips
            // the first digits of the Y-axis labels; reserve a fixed width.
            axisWidth: AXIS_LABEL_WIDTH,
          },
        },
        overrides: [],
      };
    case 'barchart':
      return {
        defaults: {
          // Shades: a single series renders in the exact brand blue (matching
          // the TOP-10 rows); extra series get shades of it, staying on-brand.
          color: { mode: FieldColorModeId.Shades, fixedColor: ANALYTIX_BLUE },
          custom: {
            lineWidth: 0,
            fillOpacity: 100,
            gradientMode: 'none',
            // Same clipping fix as timeseries (see above).
            axisWidth: AXIS_LABEL_WIDTH,
          },
        },
        overrides: [],
      };
    case 'stat':
      return {
        defaults: {
          color: { mode: FieldColorModeId.Fixed, fixedColor: ANALYTIX_GREEN_SOFT },
        },
        overrides: [],
      };
    case 'piechart':
      return {
        defaults: {
          color: { mode: FieldColorModeId.PaletteClassic },
          custom: {},
        },
        overrides: [],
      };
    case 'bargauge':
      return {
        defaults: {
          color: { mode: FieldColorModeId.Fixed, fixedColor: ANALYTIX_BLUE },
        },
        overrides: [],
      };
    case 'histogram':
      return {
        defaults: {
          color: { mode: FieldColorModeId.Shades, fixedColor: ANALYTIX_BLUE },
          custom: { lineWidth: 1, fillOpacity: 80 },
        },
        overrides: [],
      };
    case 'trend':
      return {
        defaults: {
          color: { mode: FieldColorModeId.PaletteClassic },
          custom: {
            drawStyle: 'line',
            lineInterpolation: 'linear',
            lineWidth: 1,
            fillOpacity: 0,
            gradientMode: 'none',
            showPoints: 'never',
            spanNulls: true,
            pointSize: 4,
            axisWidth: AXIS_LABEL_WIDTH,
          },
        },
        overrides: [],
      };
    case 'state-timeline':
    case 'status-history':
      return {
        defaults: {
          // Discrete states (strings or small ints) get distinct palette
          // colors; a continuous scheme would collapse strings to one color.
          color: { mode: FieldColorModeId.PaletteClassic },
          custom: { lineWidth: 0, fillOpacity: 70 },
        },
        overrides: [],
      };
    case 'xychart':
      return {
        defaults: {
          color: { mode: FieldColorModeId.PaletteClassic },
        },
        overrides: [],
      };
    // gauge / heatmap read best on their plugin defaults (threshold colors and
    // the spectral value scale respectively) — don't flatten them to the brand
    // palette.
    default:
      return { defaults: {}, overrides: [] };
  }
}

function optionsFor(panelType: SupportedPanelType): Record<string, unknown> {
  switch (panelType) {
    case 'timeseries':
      return {
        legend: { showLegend: true, displayMode: 'list', placement: 'bottom' },
        tooltip: { mode: 'multi', sort: 'desc' },
      };
    case 'barchart':
      return {
        legend: { showLegend: true, displayMode: 'list', placement: 'bottom' },
        tooltip: { mode: 'single' },
        showValue: 'auto',
        barWidth: 0.6,
        // Rotation starts at -45 as the safe default for long categorical
        // labels (provider/content names); once the query returns, the label
        // set is measured and short sets switch to horizontal — see
        // applyDynamicTickRotation.
        xTickLabelRotation: BARCHART_ROTATED_TICK_ANGLE,
        // Explicit cap: see BARCHART_ROTATED_LABEL_MAX_CHARS — the panel's
        // height-based auto mode under-shortens in the chat card, clipping
        // long rotated labels without an ellipsis.
        xTickLabelMaxLength: BARCHART_ROTATED_LABEL_MAX_CHARS,
      };
    case 'piechart':
      return {
        pieType: 'donut',
        // Slices stay clean; shares are readable from the legend instead.
        displayLabels: [],
        legend: { showLegend: true, displayMode: 'list', placement: 'right', values: ['percent'] },
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: true },
        tooltip: { mode: 'single' },
      };
    case 'stat':
      return {
        colorMode: 'value',
        graphMode: 'none',
        justifyMode: 'auto',
        textMode: 'auto',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      };
    case 'table':
      return {
        cellHeight: 'sm',
        footer: { show: false },
      };
    case 'gauge':
      return {
        showThresholdLabels: false,
        showThresholdMarkers: true,
        // One gauge per row when the query returns labeled rows; a single-row
        // single-value result still renders as one gauge.
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: true },
      };
    case 'bargauge':
      return {
        displayMode: 'basic',
        orientation: 'horizontal',
        valueMode: 'color',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: true },
      };
    case 'histogram':
      return {
        legend: { showLegend: true, displayMode: 'list', placement: 'bottom' },
        tooltip: { mode: 'single' },
      };
    case 'heatmap':
      return {
        // Bucket the raw (time, value) rows client-side; the model is told to
        // return raw-ish rows rather than pre-bucketed matrices.
        calculate: true,
        legend: { show: true },
      };
    case 'state-timeline':
      return {
        legend: { showLegend: true, displayMode: 'list', placement: 'bottom' },
        tooltip: { mode: 'single' },
        showValue: 'auto',
        rowHeight: 0.85,
        mergeValues: true,
      };
    case 'status-history':
      return {
        legend: { showLegend: true, displayMode: 'list', placement: 'bottom' },
        tooltip: { mode: 'single' },
        showValue: 'auto',
        rowHeight: 0.85,
      };
    case 'trend':
      return {
        legend: { showLegend: true, displayMode: 'list', placement: 'bottom' },
        tooltip: { mode: 'multi', sort: 'desc' },
      };
    case 'xychart':
      return {
        // Auto mapping: first numeric field is X, remaining numerics are Y.
        mapping: 'auto',
        legend: { showLegend: true, displayMode: 'list', placement: 'bottom' },
        tooltip: { mode: 'single' },
      };
    default:
      return {};
  }
}

/**
 * True when every X label of a bar chart fits horizontally under its bar at a
 * conservative panel width; undefined when the shape gives nothing to measure.
 */
export function barLabelsFitHorizontally(data: PanelData | undefined): boolean | undefined {
  const frame = data?.series?.[0];
  if (!frame || frame.length === 0) {
    return undefined;
  }
  // The X (label) field: first string field, mirroring the barchart panel's
  // own field mapping; numeric-only frames have nothing to rotate.
  const labelField = frame.fields.find((f) => f.type === FieldType.string);
  if (!labelField) {
    return undefined;
  }
  let maxLen = 0;
  for (const value of labelField.values) {
    maxLen = Math.max(maxLen, String(value ?? '').length);
  }
  const barCount = frame.length;
  // Each bar's slot must hold its widest label plus a little breathing room.
  return (maxLen + 2) * TICK_CHAR_PX * barCount <= ASSUMED_PLOT_WIDTH;
}

// The barchart options this module adjusts after the data arrives.
interface BarChartTickOptions {
  xTickLabelRotation: number;
  xTickLabelMaxLength?: number;
}

/**
 * Once the bar chart's query resolves, re-decide the X-tick label rotation
 * from the actual label set: a few short labels (e.g. 3 platforms) read best
 * horizontally, while long crowded sets keep the -45 slant. The rotated
 * default stays in place until data arrives, so long sets never flash
 * horizontal (clipped) labels first.
 */
function applyDynamicTickRotation(panel: VizPanel<BarChartTickOptions>, runner: SceneQueryRunner): void {
  runner.subscribeToState((state) => {
    if (state.data?.state !== LoadingState.Done) {
      return;
    }
    const fits = barLabelsFitHorizontally(state.data);
    if (fits === undefined) {
      return;
    }
    // onOptionsChange re-applies plugin defaults and needs the plugin loaded;
    // in the unlikely case data beats the plugin, keep the rotated default.
    if (!panel.getPlugin()) {
      return;
    }
    const rotation = fits ? 0 : BARCHART_ROTATED_TICK_ANGLE;
    const current = panel.state.options.xTickLabelRotation;
    if (current !== rotation) {
      // The ellipsis cap travels with the rotation: the panel applies the raw
      // xTickLabelMaxLength option at ANY angle, so horizontal labels must
      // clear it or short fitting sets would still be truncated. The scenes
      // options merge writes `undefined` through, removing the cap.
      panel.onOptionsChange({
        xTickLabelRotation: rotation,
        xTickLabelMaxLength: fits ? undefined : BARCHART_ROTATED_LABEL_MAX_CHARS,
      });
    }
  });
}

/**
 * The long-row shape SQL naturally produces for timeline panels: a time axis,
 * ONE entity (discriminator) column right after it, and at least one value
 * column. Exported for tests.
 */
export function timelinePartitionField(data: PanelData | undefined): string | undefined {
  if (!data || data.series.length !== 1) {
    return undefined; // already multi-frame (or nothing) — leave as-is
  }
  const frame: DataFrame = data.series[0];
  if (frame.fields.length < 3) {
    return undefined;
  }
  const [first, second] = frame.fields;
  return first.type === FieldType.time && second.type === FieldType.string ? second.name : undefined;
}

/**
 * The long-row shape SQL naturally produces for the trend panel: a numeric X
 * column, ONE entity (string) column and at least one value column, e.g.
 * (day_num, device_type, watch_seconds). Column order does not matter — the
 * panel picks the first numeric field as X on its own. Exported for tests.
 */
export function trendPartitionField(data: PanelData | undefined): string | undefined {
  if (!data || data.series.length !== 1) {
    return undefined; // already multi-frame (or nothing) — leave as-is
  }
  const frame: DataFrame = data.series[0];
  const stringFields = frame.fields.filter((f) => f.type === FieldType.string);
  const numberFields = frame.fields.filter((f) => f.type === FieldType.number);
  // Exactly one discriminator, plus X and at least one value to plot.
  return stringFields.length === 1 && numberFields.length >= 2 ? stringFields[0].name : undefined;
}

/**
 * state-timeline / status-history want one field per tracked entity, but SQL
 * returns long rows (time, entity, state) — a ClickHouse pivot would need the
 * entity list hardcoded into the query. Partition the long frame by the
 * entity column instead; wide results pass through untouched.
 */
export function timelinePivotTransformations(data: PanelData | undefined): DataTransformerConfig[] {
  const field = timelinePartitionField(data);
  return field ? [{ id: 'partitionByValues', options: { fields: [field], keepFields: false } }] : [];
}

/**
 * The trend panel accepts exactly ONE frame whose X field is ascending, so
 * long rows (x, entity, value) fail with "Values must be in ascending order":
 * X repeats once per entity. Partition by the entity column like the
 * timelines do, then fold the per-entity frames back into one wide frame
 * with an outer join on X (the join sorts X ascending and fills gaps with
 * nulls); wide results pass through untouched.
 */
export function trendPivotTransformations(data: PanelData | undefined): DataTransformerConfig[] {
  const field = trendPartitionField(data);
  if (!field) {
    return [];
  }
  // Same rule the panel uses to pick its X axis (options.xField is never set).
  const xField = data!.series[0].fields.find((f) => f.type === FieldType.number)!;
  return [
    { id: 'partitionByValues', options: { fields: [field], keepFields: false } },
    { id: 'joinByField', options: { byField: xField.name, mode: 'outer' } },
  ];
}

/**
 * Once the query resolves, derive the pivot for its actual shape and swap it
 * into the (initially pass-through) transformer; no-op when nothing changed.
 */
function applyLongFormatPivot(
  transformer: SceneDataTransformer,
  runner: SceneQueryRunner,
  transformationsFor: (data: PanelData) => DataTransformerConfig[]
): void {
  runner.subscribeToState((state) => {
    if (state.data?.state !== LoadingState.Done) {
      return;
    }
    const current = transformer.state.transformations;
    const wanted = transformationsFor(state.data);
    if (JSON.stringify(current) !== JSON.stringify(wanted)) {
      transformer.setState({ transformations: wanted });
      transformer.reprocessTransformations();
    }
  });
}

/** Name of the first time field of the query result, if any. Exported for tests. */
export function timeFieldName(data: PanelData | undefined): string | undefined {
  return data?.series?.[0]?.fields.find((f) => f.type === FieldType.time)?.name;
}

/**
 * True for the long time-series shape — a time column, at least one string
 * (entity) column and at least one numeric column — i.e. exactly the frames
 * the ClickHouse datasource used to pivot server-side. Exported for tests.
 */
export function isLongTimeSeries(data: PanelData | undefined): boolean {
  const fields = data?.series?.[0]?.fields;
  if (!fields || data!.series.length !== 1) {
    return false;
  }
  return (
    fields.some((f) => f.type === FieldType.time) &&
    fields.some((f) => f.type === FieldType.string) &&
    fields.some((f) => f.type === FieldType.number)
  );
}

/** True when the first frame's time column holds at least one NULL. Exported for tests. */
export function timeHasNulls(data: PanelData | undefined): boolean {
  const time = data?.series?.[0]?.fields.find((f) => f.type === FieldType.time);
  return Boolean(time?.values.some((v) => v == null));
}

// Sort the frame by its time column ascending. The transformer matches the
// field by display name, which for a raw single-frame query result is the
// column name.
const sortByTime = (field: string): DataTransformerConfig => ({
  id: 'sortBy',
  options: { sort: [{ field, desc: false }] },
});

// Drop the rows whose time is NULL (a LEFT JOIN with no match, min() over an
// empty set): they cannot be placed on the axis, and the datasource used to
// reject the whole result over them. Same display-name matching as sortBy.
const dropNullTime = (field: string): DataTransformerConfig => ({
  id: 'filterByValue',
  options: {
    type: 'exclude',
    match: 'any',
    filters: [{ fieldName: field, config: { id: 'isNull', options: {} } }],
  },
});

/**
 * timeseries: the query now returns raw rows (format Table, see
 * datasourceQuery.ts), so the client does what the datasource's LongToWide
 * did — minus its failure modes. "Prepare time series → multi" rebuilds the
 * frame with the time column first and sorted ascending, drops rows whose
 * time is NULL, splits a long (time, entity, value) result into one frame per
 * entity (labelled by the entity, so the legend reads "active_users 222" as
 * before) and leaves a wide (time, a, b) result visually unchanged. Applied
 * only when the result has a time column at all: without one the panel's own
 * "Data is missing a time field" message is more useful than an empty chart.
 */
export function timeSeriesTransformations(data: PanelData | undefined): DataTransformerConfig[] {
  const time = timeFieldName(data);
  if (!time) {
    return [];
  }
  // The multi split skips NULL times only while splitting a long result; a
  // wide (time, a, b) result keeps them, so they are filtered out up front.
  return [
    ...(timeHasNulls(data) ? [dropNullTime(time)] : []),
    { id: 'prepareTimeSeries', options: { format: 'multi' } },
  ];
}

/**
 * barchart over time: a long (time, category, value) result is folded into one
 * wide frame (time, value{category=A}, value{category=B}, ...) — one bar group
 * per time bucket, one bar per category, as the server-side pivot produced.
 * The multi step sorts and drops NULL times; the wide step joins by time.
 * Plain (category, value) and (time, value) results pass through untouched.
 */
export function barChartTransformations(data: PanelData | undefined): DataTransformerConfig[] {
  return isLongTimeSeries(data)
    ? [
        { id: 'prepareTimeSeries', options: { format: 'multi' } },
        { id: 'prepareTimeSeries', options: { format: 'wide' } },
      ]
    : [];
}

/**
 * state-timeline / status-history: rows sorted by time first (the timeline
 * panels draw rows in input order), then the long-format pivot above. The
 * partition keeps each entity's rows in the already-sorted order.
 */
export function timelineTransformations(data: PanelData | undefined): DataTransformerConfig[] {
  const time = timeFieldName(data);
  if (!time) {
    return timelinePivotTransformations(data);
  }
  return [...(timeHasNulls(data) ? [dropNullTime(time)] : []), sortByTime(time), ...timelinePivotTransformations(data)];
}

// Panels whose results are reshaped client-side once their shape is known.
const DATA_SHAPED_TRANSFORMATIONS: Partial<Record<SupportedPanelType, (data: PanelData) => DataTransformerConfig[]>> = {
  timeseries: timeSeriesTransformations,
  barchart: barChartTransformations,
  'state-timeline': timelineTransformations,
  'status-history': timelineTransformations,
  trend: trendPivotTransformations,
};

/**
 * Build a panel from a generated spec for inline rendering (not attached to a
 * dashboard). It is a bare VizPanel — no dashboard menu/behaviours — so it
 * renders happily inside an EmbeddedScene.
 */
export function buildGeneratedPanel(spec: GeneratedPanelSpec, datasource: DataSourceRef): VizPanel {
  // Final execution boundary: the panel query runs through the user's datasource
  // on every refresh, so it clears the same read-only gate as the bridge queries.
  // normalizeResult already drops unsafe specs; this is defense in depth for any
  // other caller and keeps the guarantee close to where the SQL is executed.
  if (!isSafeBridgeSql(spec.rawSql)) {
    throw new Error('Refusing to build a panel: the generated SQL is not a single read-only query.');
  }
  const runner = new SceneQueryRunner({
    datasource,
    // Raw rows in table format; the reshaping for chart panels happens below.
    queries: [rawSqlQuery(datasource, spec.rawSql)],
  });
  // Reshaped panels sit behind a (initially pass-through) transformer so the
  // result can be re-prepared once its shape is known.
  const reshape = DATA_SHAPED_TRANSFORMATIONS[spec.panelType];
  const data = reshape ? new SceneDataTransformer({ $data: runner, transformations: [] }) : runner;
  const fieldConfig = fieldConfigFor(spec.panelType);
  if (!UNFORMATTED_PANEL_TYPES.includes(spec.panelType)) {
    fieldConfig.defaults = { unit: DEFAULT_NUMBER_UNIT, ...fieldConfig.defaults };
  }
  const panel = new VizPanel({
    title: spec.title,
    pluginId: spec.panelType,
    displayMode: 'transparent',
    fieldConfig,
    options: optionsFor(spec.panelType),
    $data: data,
  });
  if (spec.panelType === 'barchart') {
    // The subscription shares the panel's lifetime: the runner is a child of
    // the panel, so both are released together with the chat entry.
    applyDynamicTickRotation(panel, runner);
  }
  if (reshape && data instanceof SceneDataTransformer) {
    applyLongFormatPivot(data, runner, reshape);
  }
  return panel;
}
