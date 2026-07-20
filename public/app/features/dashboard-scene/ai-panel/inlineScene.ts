import { EmbeddedScene, SceneFlexItem, SceneFlexLayout, SceneTimeRange, VizPanel } from '@grafana/scenes';

/**
 * Wrap a VizPanel in a self-contained EmbeddedScene so it can be rendered inline
 * (e.g. inside the chat) without being attached to a dashboard. The scene owns
 * its own time range, which the panel's query runner reads when it activates.
 */
export function buildInlineChartScene(panel: VizPanel, timeFrom = 'now-6h', timeTo = 'now'): EmbeddedScene {
  return new EmbeddedScene({
    $timeRange: new SceneTimeRange({ from: timeFrom, to: timeTo }),
    body: new SceneFlexLayout({
      direction: 'column',
      children: [new SceneFlexItem({ minHeight: 240, body: panel })],
    }),
  });
}
