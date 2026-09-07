import { lastValueFrom } from 'rxjs';

import {
  FieldType,
  LoadingState,
  PanelData,
  toDataFrame,
  getDefaultTimeRange,
  standardTransformersRegistry,
  transformDataFrame,
} from '@grafana/data';
import { SceneDataTransformer, SceneQueryRunner } from '@grafana/scenes';
import { getStandardTransformers } from 'app/features/transformers/standardTransformers';

import {
  barChartTransformations,
  barLabelsFitHorizontally,
  buildGeneratedPanel,
  isLongTimeSeries,
  timeFieldName,
  timeHasNulls,
  timeSeriesTransformations,
  timelinePartitionField,
  timelineTransformations,
  trendPartitionField,
  trendPivotTransformations,
} from './buildPanel';
import { OFFICIAL_CLICKHOUSE_PLUGIN_ID } from './datasourceQuery';
import { GeneratedPanelSpec } from './types';

standardTransformersRegistry.setInit(getStandardTransformers);

function panelData(labels: unknown[], values: number[]): PanelData {
  return {
    state: LoadingState.Done,
    timeRange: getDefaultTimeRange(),
    series: [
      toDataFrame({
        fields: [
          { name: 'label', type: FieldType.string, values: labels },
          { name: 'value', type: FieldType.number, values },
        ],
      }),
    ],
  };
}

describe('barLabelsFitHorizontally', () => {
  it('fits a few short platform labels', () => {
    expect(barLabelsFitHorizontally(panelData(['Android', 'tvOS', 'iOS'], [70, 7, 4]))).toBe(true);
  });

  it('fits a few brand labels', () => {
    expect(barLabelsFitHorizontally(panelData(['Samsung', 'LG', ''], [55383, 53463, 22]))).toBe(true);
  });

  it('rejects many long provider labels', () => {
    const labels = Array.from({ length: 10 }, (_, i) => `Provider With A Long Name ${i}`);
    expect(
      barLabelsFitHorizontally(
        panelData(
          labels,
          labels.map((_, i) => i)
        )
      )
    ).toBe(false);
  });

  it('rejects a crowd of short labels', () => {
    const labels = Array.from({ length: 40 }, (_, i) => `P${i}`);
    expect(
      barLabelsFitHorizontally(
        panelData(
          labels,
          labels.map((_, i) => i)
        )
      )
    ).toBe(false);
  });

  it('is undefined without data or a string field', () => {
    expect(barLabelsFitHorizontally(undefined)).toBeUndefined();
    expect(barLabelsFitHorizontally(panelData([], []))).toBeUndefined();
    const numericOnly: PanelData = {
      state: LoadingState.Done,
      timeRange: getDefaultTimeRange(),
      series: [toDataFrame({ fields: [{ name: 'value', type: FieldType.number, values: [1, 2] }] })],
    };
    expect(barLabelsFitHorizontally(numericOnly)).toBeUndefined();
  });

  it('handles null label cells', () => {
    expect(barLabelsFitHorizontally(panelData(['Android', null, 'iOS'], [1, 2, 3]))).toBe(true);
  });
});

describe('timelinePartitionField', () => {
  const frameData = (fields: Array<{ name: string; type: FieldType; values: unknown[] }>): PanelData => ({
    state: LoadingState.Done,
    timeRange: getDefaultTimeRange(),
    series: [toDataFrame({ fields })],
  });

  it('detects the long (time, entity, state) shape', () => {
    const data = frameData([
      { name: 't', type: FieldType.time, values: [1, 2] },
      { name: 'provider', type: FieldType.string, values: ['A', 'B'] },
      { name: 'state', type: FieldType.number, values: [0, 1] },
    ]);
    expect(timelinePartitionField(data)).toBe('provider');
  });

  it('leaves wide (already pivoted) results alone', () => {
    const data = frameData([
      { name: 't', type: FieldType.time, values: [1, 2] },
      { name: 'A', type: FieldType.number, values: [0, 1] },
      { name: 'B', type: FieldType.number, values: [1, 0] },
    ]);
    expect(timelinePartitionField(data)).toBeUndefined();
  });

  it('ignores frames without a leading time axis or with too few columns', () => {
    expect(
      timelinePartitionField(
        frameData([
          { name: 'provider', type: FieldType.string, values: ['A'] },
          { name: 'state', type: FieldType.number, values: [1] },
        ])
      )
    ).toBeUndefined();
    expect(
      timelinePartitionField(
        frameData([
          { name: 't', type: FieldType.time, values: [1] },
          { name: 'state', type: FieldType.number, values: [1] },
        ])
      )
    ).toBeUndefined();
    expect(timelinePartitionField(undefined)).toBeUndefined();
  });
});

describe('trendPartitionField', () => {
  const frameData = (fields: Array<{ name: string; type: FieldType; values: unknown[] }>): PanelData => ({
    state: LoadingState.Done,
    timeRange: getDefaultTimeRange(),
    series: [toDataFrame({ fields })],
  });

  it('detects the long (x, entity, value) shape regardless of column order', () => {
    expect(
      trendPartitionField(
        frameData([
          { name: 'day_num', type: FieldType.number, values: [1, 1, 2, 2] },
          { name: 'device_type', type: FieldType.string, values: ['a', 'b', 'a', 'b'] },
          { name: 'watch_seconds', type: FieldType.number, values: [10, 20, 30, 40] },
        ])
      )
    ).toBe('device_type');
    expect(
      trendPartitionField(
        frameData([
          { name: 'device_type', type: FieldType.string, values: ['a', 'b'] },
          { name: 'day_num', type: FieldType.number, values: [1, 1] },
          { name: 'watch_seconds', type: FieldType.number, values: [10, 20] },
        ])
      )
    ).toBe('device_type');
  });

  it('leaves single-series and wide results alone', () => {
    expect(
      trendPartitionField(
        frameData([
          { name: 'day_num', type: FieldType.number, values: [1, 2] },
          { name: 'watch_seconds', type: FieldType.number, values: [10, 20] },
        ])
      )
    ).toBeUndefined();
    expect(
      trendPartitionField(
        frameData([
          { name: 'day_num', type: FieldType.number, values: [1, 2] },
          { name: 'a', type: FieldType.number, values: [1, 2] },
          { name: 'b', type: FieldType.number, values: [3, 4] },
        ])
      )
    ).toBeUndefined();
    expect(trendPartitionField(undefined)).toBeUndefined();
  });

  it('ignores frames with several string columns or no value column', () => {
    expect(
      trendPartitionField(
        frameData([
          { name: 'day_num', type: FieldType.number, values: [1] },
          { name: 'device_type', type: FieldType.string, values: ['a'] },
          { name: 'country', type: FieldType.string, values: ['x'] },
          { name: 'watch_seconds', type: FieldType.number, values: [10] },
        ])
      )
    ).toBeUndefined();
    expect(
      trendPartitionField(
        frameData([
          { name: 'day_num', type: FieldType.number, values: [1] },
          { name: 'device_type', type: FieldType.string, values: ['a'] },
        ])
      )
    ).toBeUndefined();
  });
});

describe('trendPivotTransformations', () => {
  // The exact shape the "watch time by device type" query returned: five
  // devices per day, X repeating once per device — rejected by the trend
  // panel as-is ("Values must be in ascending order").
  const longRows: PanelData = {
    state: LoadingState.Done,
    timeRange: getDefaultTimeRange(),
    series: [
      toDataFrame({
        fields: [
          { name: 'day_num', type: FieldType.number, values: [20696, 20696, 20697, 20697, 20698] },
          { name: 'device_type', type: FieldType.string, values: ['Android', 'SmartTV', 'Android', 'SmartTV', 'web'] },
          { name: 'watch_seconds', type: FieldType.number, values: [1, 2, 3, 4, 5] },
        ],
      }),
    ],
  };

  it('is a no-op for shapes the panel already accepts', () => {
    expect(trendPivotTransformations(undefined)).toEqual([]);
    const wide: PanelData = {
      ...longRows,
      series: [
        toDataFrame({
          fields: [
            { name: 'day_num', type: FieldType.number, values: [1, 2] },
            { name: 'watch_seconds', type: FieldType.number, values: [10, 20] },
          ],
        }),
      ],
    };
    expect(trendPivotTransformations(wide)).toEqual([]);
  });

  it('folds long rows into one wide frame with an ascending, de-duplicated X', async () => {
    const transformations = trendPivotTransformations(longRows);
    expect(transformations.map((t) => t.id)).toEqual(['partitionByValues', 'joinByField']);

    const frames = await lastValueFrom(transformDataFrame(transformations, longRows.series));
    expect(frames).toHaveLength(1);
    const [frame] = frames;
    const x = frame.fields.find((f) => f.name === 'day_num')!;
    expect(x.values).toEqual([20696, 20697, 20698]);
    // One value column per device; the outer join leaves a gap (undefined)
    // where a device has no row for a day.
    const values = frame.fields.filter((f) => f.name === 'watch_seconds');
    expect(values.map((f) => f.labels?.device_type)).toEqual(['Android', 'SmartTV', 'web']);
    expect(values.map((f) => f.values)).toEqual([
      [1, 3, undefined],
      [2, 4, undefined],
      [undefined, undefined, 5],
    ]);
  });
});

// The shape the ClickHouse datasource used to pivot server-side (and choked on
// when the rows were not time-sorted or a time was NULL): raw long rows of
// (time, entity, value), here out of order and with one NULL time.
const longTimeSeries = (): PanelData => ({
  state: LoadingState.Done,
  timeRange: getDefaultTimeRange(),
  series: [
    toDataFrame({
      fields: [
        { name: 'day', type: FieldType.time, values: [2000, 1000, null, 2000, 1000] },
        { name: 'pid', type: FieldType.string, values: ['222', '222', '111', '111', '111'] },
        { name: 'active_users', type: FieldType.number, values: [22, 21, 99, 12, 11] },
      ],
    }),
  ],
});

describe('time-axis reshaping', () => {
  it('detects the time column and the long shape', () => {
    expect(timeFieldName(longTimeSeries())).toBe('day');
    expect(isLongTimeSeries(longTimeSeries())).toBe(true);
    expect(timeFieldName(undefined)).toBeUndefined();
    expect(isLongTimeSeries(undefined)).toBe(false);
    // (label, value) has no time axis; (time, value) has no entity column.
    expect(isLongTimeSeries(panelData(['a', 'b'], [1, 2]))).toBe(false);
    const wide: PanelData = {
      ...longTimeSeries(),
      series: [
        toDataFrame({
          fields: [
            { name: 't', type: FieldType.time, values: [1, 2] },
            { name: 'v', type: FieldType.number, values: [1, 2] },
          ],
        }),
      ],
    };
    expect(isLongTimeSeries(wide)).toBe(false);
    expect(timeFieldName(wide)).toBe('t');
  });

  it('timeseries: splits long rows per entity, sorted by time, NULL times dropped', async () => {
    const data = longTimeSeries();
    expect(timeHasNulls(data)).toBe(true);
    const transformations = timeSeriesTransformations(data);
    expect(transformations.map((t) => t.id)).toEqual(['filterByValue', 'prepareTimeSeries']);

    const frames = await lastValueFrom(transformDataFrame(transformations, data.series));
    expect(frames).toHaveLength(2);
    const byPid = Object.fromEntries(frames.map((f) => [f.fields[1].labels?.pid, f]));
    expect(byPid['222'].fields[0].values).toEqual([1000, 2000]);
    expect(byPid['222'].fields[1].values).toEqual([21, 22]);
    expect(byPid['222'].fields[1].name).toBe('active_users');
    // The NULL-time row (value 99) is gone; the rest is in time order.
    expect(byPid['111'].fields[0].values).toEqual([1000, 2000]);
    expect(byPid['111'].fields[1].values).toEqual([11, 12]);
  });

  it('timeseries: sorts a wide result and drops its NULL-time rows', async () => {
    const wide: PanelData = {
      ...longTimeSeries(),
      series: [
        toDataFrame({
          fields: [
            { name: 't', type: FieldType.time, values: [3000, null, 1000] },
            { name: 'a', type: FieldType.number, values: [3, 99, 1] },
            { name: 'b', type: FieldType.number, values: [30, 99, 10] },
          ],
        }),
      ],
    };
    const transformations = timeSeriesTransformations(wide);
    expect(transformations.map((t) => t.id)).toEqual(['filterByValue', 'prepareTimeSeries']);
    const frames = await lastValueFrom(transformDataFrame(transformations, wide.series));
    expect(frames.map((f) => f.fields[1].name)).toEqual(['a', 'b']);
    for (const frame of frames) {
      expect(frame.fields[0].values).toEqual([1000, 3000]);
    }
    expect(frames[0].fields[1].values).toEqual([1, 3]);
    expect(frames[1].fields[1].values).toEqual([10, 30]);
    // Clean data needs no filter step.
    const clean: PanelData = {
      ...wide,
      series: [
        toDataFrame({
          fields: [
            { name: 't', type: FieldType.time, values: [1, 2] },
            { name: 'a', type: FieldType.number, values: [1, 2] },
          ],
        }),
      ],
    };
    expect(timeHasNulls(clean)).toBe(false);
    expect(timeSeriesTransformations(clean).map((t) => t.id)).toEqual(['prepareTimeSeries']);
  });

  it('timeseries: leaves a result without a time column to the panel itself', () => {
    expect(timeSeriesTransformations(panelData(['a'], [1]))).toEqual([]);
    expect(timeSeriesTransformations(undefined)).toEqual([]);
    expect(timeHasNulls(undefined)).toBe(false);
  });

  it('barchart: folds long rows over time into one wide frame, and passes plain results through', async () => {
    const data = longTimeSeries();
    const transformations = barChartTransformations(data);
    expect(transformations.map((t) => t.id)).toEqual(['prepareTimeSeries', 'prepareTimeSeries']);

    const frames = await lastValueFrom(transformDataFrame(transformations, data.series));
    expect(frames).toHaveLength(1);
    const [frame] = frames;
    expect(frame.fields[0].type).toBe(FieldType.time);
    expect(frame.fields[0].values).toEqual([1000, 2000]);
    const values = frame.fields.filter((f) => f.type === FieldType.number);
    expect(values.map((f) => f.labels?.pid).sort()).toEqual(['111', '222']);

    expect(barChartTransformations(panelData(['a', 'b'], [1, 2]))).toEqual([]);
    expect(barChartTransformations(undefined)).toEqual([]);
  });

  it('timelines: drop NULL times, sort by time, then partition long rows by entity', async () => {
    const data = longTimeSeries();
    const transformations = timelineTransformations(data);
    expect(transformations.map((t) => t.id)).toEqual(['filterByValue', 'sortBy', 'partitionByValues']);

    const frames = await lastValueFrom(transformDataFrame(transformations, data.series));
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect(frame.fields[0].values).toEqual([1000, 2000]);
      // The entity column moved into the labels.
      expect(frame.fields.map((f) => f.name)).toEqual(['day', 'active_users']);
    }
    // A wide (time, a, b) result only gets the sort.
    const wide: PanelData = {
      ...data,
      series: [
        toDataFrame({
          fields: [
            { name: 't', type: FieldType.time, values: [2, 1] },
            { name: 'a', type: FieldType.number, values: [0, 1] },
          ],
        }),
      ],
    };
    expect(timelineTransformations(wide).map((t) => t.id)).toEqual(['sortBy']);
    expect(timelineTransformations(undefined)).toEqual([]);
  });
});

describe('buildGeneratedPanel SQL gate', () => {
  const datasource = { uid: 'ch-uid', type: 'clickhouse' };
  const spec = (rawSql: string): GeneratedPanelSpec => ({ panelType: 'table', title: 'T', rawSql });

  it('builds a panel for a read-only query', () => {
    const panel = buildGeneratedPanel(spec('SELECT count() FROM stat.events'), datasource);
    expect(panel.state.pluginId).toBe('table');
  });

  it.each(['timeseries', 'barchart', 'state-timeline', 'status-history', 'trend'] as const)(
    'builds a %s panel behind a pass-through transformer',
    (panelType) => {
      const panel = buildGeneratedPanel(
        { panelType, title: 'T', rawSql: 'SELECT t, p, s FROM stat.events' },
        datasource
      );
      expect(panel.state.pluginId).toBe(panelType);
      expect(panel.state.$data?.constructor.name).toBe('SceneDataTransformer');
    }
  );

  it.each(['table', 'stat', 'piechart', 'gauge', 'bargauge', 'histogram', 'heatmap', 'xychart'] as const)(
    'does not wrap a %s panel, which takes the query result as-is',
    (panelType) => {
      const panel = buildGeneratedPanel({ panelType, title: 'T', rawSql: 'SELECT t, v FROM stat.events' }, datasource);
      expect(panel.state.$data?.constructor.name).toBe('SceneQueryRunner');
    }
  );

  it('asks the official ClickHouse plugin for table-format rows', () => {
    const official = { uid: 'ch-uid', type: OFFICIAL_CLICKHOUSE_PLUGIN_ID };
    const panel = buildGeneratedPanel({ panelType: 'timeseries', title: 'T', rawSql: 'SELECT t, v FROM x' }, official);
    const transformer = panel.state.$data as SceneDataTransformer;
    const runner = transformer.state.$data as SceneQueryRunner;
    expect(runner.state.queries[0]).toEqual({
      refId: 'A',
      rawSql: 'SELECT t, v FROM x',
      query: 'SELECT t, v FROM x',
      format: 1,
    });
    // The community plugin types `format` as a string: leave it on its default.
    const community = buildGeneratedPanel(spec('SELECT 1'), datasource);
    expect((community.state.$data as SceneQueryRunner).state.queries[0]).toEqual({
      refId: 'A',
      rawSql: 'SELECT 1',
      query: 'SELECT 1',
    });
  });

  it('abbreviates numbers everywhere except tables and heatmaps', () => {
    const unitOf = (panelType: GeneratedPanelSpec['panelType']) =>
      buildGeneratedPanel({ panelType, title: 'T', rawSql: 'SELECT 1' }, datasource).state.fieldConfig.defaults.unit;
    expect(unitOf('timeseries')).toBe('short');
    expect(unitOf('gauge')).toBe('short');
    expect(unitOf('table')).toBeUndefined();
    expect(unitOf('heatmap')).toBeUndefined();
  });

  it('rejects a mutating statement', () => {
    expect(() => buildGeneratedPanel(spec('INSERT INTO t VALUES (1)'), datasource)).toThrow();
  });

  it('rejects a multi-statement query', () => {
    expect(() => buildGeneratedPanel(spec('SELECT 1; DROP TABLE t'), datasource)).toThrow();
  });

  it('rejects an external table function (SSRF vector)', () => {
    expect(() => buildGeneratedPanel(spec("SELECT * FROM url('http://169.254.169.254/', CSV)"), datasource)).toThrow();
  });
});
