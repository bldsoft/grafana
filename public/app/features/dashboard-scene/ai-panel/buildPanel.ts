import { DataSourceRef, FieldColorModeId, FieldType, LoadingState, PanelData } from '@grafana/data';
import { SceneQueryRunner, VizPanel } from '@grafana/scenes';

import { isSafeBridgeSql } from './datasourceQuery';
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
// Approximate axis-font character width (px) for the fits-horizontally check.
const TICK_CHAR_PX = 8;
// Conservative plot width (px): the chat card is normally wider, so a set that
// fits at this width fits everywhere the panel is rendered.
const ASSUMED_PLOT_WIDTH = 600;

function fieldConfigFor(panelType: SupportedPanelType) {
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
        // No explicit max length: a fixed cap disables the panel's own
        // height-based auto-ellipsis, and rotated labels longer than the
        // reserved space get clipped without an ellipsis. The auto mode trims
        // to what fits the panel height (full value stays in the tooltip).
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

// The one barchart option this module adjusts after the data arrives.
interface BarChartTickOptions {
  xTickLabelRotation: number;
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
      panel.onOptionsChange({ xTickLabelRotation: rotation });
    }
  });
}

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
    // `rawSql`/`query` cover both the official and community ClickHouse plugins.
    queries: [{ refId: 'A', rawSql: spec.rawSql, query: spec.rawSql }],
  });
  const panel = new VizPanel({
    title: spec.title,
    pluginId: spec.panelType,
    displayMode: 'transparent',
    fieldConfig: fieldConfigFor(spec.panelType),
    options: optionsFor(spec.panelType),
    $data: runner,
  });
  if (spec.panelType === 'barchart') {
    // The subscription shares the panel's lifetime: the runner is a child of
    // the panel, so both are released together with the chat entry.
    applyDynamicTickRotation(panel, runner);
  }
  return panel;
}
