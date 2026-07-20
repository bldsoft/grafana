import { DataSourceRef } from '@grafana/data';
import { SceneQueryRunner, VizPanel } from '@grafana/scenes';

import { GeneratedPanelSpec } from './types';

/**
 * Build a panel from a generated spec for inline rendering (not attached to a
 * dashboard). It is a bare VizPanel — no dashboard menu/behaviours — so it
 * renders happily inside an EmbeddedScene.
 */
export function buildGeneratedPanel(spec: GeneratedPanelSpec, datasource: DataSourceRef): VizPanel {
  return new VizPanel({
    title: spec.title,
    pluginId: spec.panelType,
    $data: new SceneQueryRunner({
      datasource,
      // `rawSql`/`query` cover both the official and community ClickHouse plugins.
      queries: [{ refId: 'A', rawSql: spec.rawSql, query: spec.rawSql }],
    }),
  });
}
