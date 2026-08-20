import { DataSourceRef, FieldColorModeId } from '@grafana/data';
import { SceneQueryRunner, VizPanel } from '@grafana/scenes';

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
        // Generated charts often have long categorical labels (provider or
        // content names) that overlap horizontally; slant them like Grafana's
        // own rotated-tick layout and ellipsize the extra-long ones.
        xTickLabelRotation: -45,
        xTickLabelMaxLength: 24,
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
 * Build a panel from a generated spec for inline rendering (not attached to a
 * dashboard). It is a bare VizPanel — no dashboard menu/behaviours — so it
 * renders happily inside an EmbeddedScene.
 */
export function buildGeneratedPanel(spec: GeneratedPanelSpec, datasource: DataSourceRef): VizPanel {
  return new VizPanel({
    title: spec.title,
    pluginId: spec.panelType,
    displayMode: 'transparent',
    fieldConfig: fieldConfigFor(spec.panelType),
    options: optionsFor(spec.panelType),
    $data: new SceneQueryRunner({
      datasource,
      // `rawSql`/`query` cover both the official and community ClickHouse plugins.
      queries: [{ refId: 'A', rawSql: spec.rawSql, query: spec.rawSql }],
    }),
  });
}
