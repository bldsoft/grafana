import { DataSourceRef, getDataSourceRef } from '@grafana/data';
import { getDataSourceSrv } from '@grafana/runtime';
import { SceneQueryRunner, VizPanel } from '@grafana/scenes';

/**
 * Demo mode. When enabled, the AI panel generator skips the LLM and ClickHouse
 * and builds a sample chart from the built-in TestData datasource, so the whole
 * flow can be shown end-to-end without configuring grafana-llm-app or ClickHouse.
 *
 * The real path talks to the ai-grafana-helper service (see assistantClient.ts);
 * flip this back to `true` for offline demos without the service and VPN.
 */
export const AI_PANEL_DEMO_MODE = false;

const TESTDATA_PLUGIN_ID = 'grafana-testdata-datasource';

// A header row of slice labels + one row of values → a pie chart with 5 slices.
const DEMO_CSV = ['Chrome,Firefox,Safari,Edge,Other', '47,18,15,12,8'].join('\n');

// A few demo layouts so repeated prompts don't all look identical in the chat.
const DEMO_VARIANTS: Array<{ pluginId: string; scenarioId: string; csvContent: string }> = [
  { pluginId: 'piechart', scenarioId: 'csv_content', csvContent: DEMO_CSV },
  {
    pluginId: 'barchart',
    scenarioId: 'csv_content',
    csvContent: ['Mon,Tue,Wed,Thu,Fri', '12,19,7,15,22'].join('\n'),
  },
  { pluginId: 'timeseries', scenarioId: 'random_walk', csvContent: '' },
  {
    pluginId: 'stat',
    scenarioId: 'csv_content',
    csvContent: ['Active,Idle,Errors', '128,42,3'].join('\n'),
  },
];

/**
 * Build a sample panel for inline rendering (not attached to any dashboard).
 * It is a bare VizPanel — no dashboard menu/behaviours — so it renders happily
 * inside an EmbeddedScene. `index` rotates the chart type.
 */
export function buildDemoPanel(title: string, index = 0): VizPanel {
  const variant = DEMO_VARIANTS[index % DEMO_VARIANTS.length];
  const query =
    variant.scenarioId === 'random_walk'
      ? { refId: 'A', scenarioId: variant.scenarioId }
      : { refId: 'A', scenarioId: variant.scenarioId, csvContent: variant.csvContent };

  return new VizPanel({
    title: title.trim() || 'Demo chart',
    pluginId: variant.pluginId,
    $data: new SceneQueryRunner({
      datasource: getTestDataRef(),
      queries: [query],
    }),
  });
}

function getTestDataRef(): DataSourceRef {
  const [settings] = getDataSourceSrv().getList({ pluginId: TESTDATA_PLUGIN_ID });

  if (settings) {
    return getDataSourceRef(settings);
  }

  // Fall back to a type-only ref; Grafana provisions TestData by default.
  return { type: TESTDATA_PLUGIN_ID };
}
