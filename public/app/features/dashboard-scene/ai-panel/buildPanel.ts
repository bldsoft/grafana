import { DataSourceRef, FieldColorModeId } from '@grafana/data';
import { SceneQueryRunner, VizPanel } from '@grafana/scenes';

import { GeneratedPanelSpec, SupportedPanelType } from './types';

/**
 * Analytix: per-panel-type visual defaults so generated charts land in the
 * brand look (smooth green gradients on dark) instead of bare plugin defaults.
 */
const ANALYTIX_GREEN = '#45d157';

function fieldConfigFor(panelType: SupportedPanelType) {
  switch (panelType) {
    case 'timeseries':
      return {
        defaults: {
          color: { mode: FieldColorModeId.PaletteClassic },
          custom: {
            drawStyle: 'line',
            lineInterpolation: 'smooth',
            lineWidth: 2,
            fillOpacity: 16,
            gradientMode: 'opacity',
            showPoints: 'never',
            spanNulls: true,
            pointSize: 4,
          },
        },
        overrides: [],
      };
    case 'barchart':
      return {
        defaults: {
          color: { mode: FieldColorModeId.PaletteClassic },
          custom: {
            lineWidth: 0,
            fillOpacity: 85,
            gradientMode: 'hue',
          },
        },
        overrides: [],
      };
    case 'stat':
      return {
        defaults: {
          color: { mode: FieldColorModeId.Fixed, fixedColor: ANALYTIX_GREEN },
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
        showValue: 'never',
        barWidth: 0.72,
      };
    case 'piechart':
      return {
        pieType: 'donut',
        displayLabels: ['percent'],
        legend: { showLegend: true, displayMode: 'list', placement: 'right', values: [] },
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: true },
        tooltip: { mode: 'single' },
      };
    case 'stat':
      return {
        colorMode: 'value',
        graphMode: 'area',
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
