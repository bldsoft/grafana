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
import { getStandardTransformers } from 'app/features/transformers/standardTransformers';

import {
  barLabelsFitHorizontally,
  buildGeneratedPanel,
  timelinePartitionField,
  trendPartitionField,
  trendPivotTransformations,
} from './buildPanel';
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

describe('buildGeneratedPanel SQL gate', () => {
  const datasource = { uid: 'ch-uid', type: 'clickhouse' };
  const spec = (rawSql: string): GeneratedPanelSpec => ({ panelType: 'table', title: 'T', rawSql });

  it('builds a panel for a read-only query', () => {
    const panel = buildGeneratedPanel(spec('SELECT count() FROM stat.events'), datasource);
    expect(panel.state.pluginId).toBe('table');
  });

  it.each(['state-timeline', 'status-history', 'trend'] as const)(
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

  it('does not wrap panels that take the query result as-is', () => {
    const panel = buildGeneratedPanel(
      { panelType: 'timeseries', title: 'T', rawSql: 'SELECT t, v FROM stat.events' },
      datasource
    );
    expect(panel.state.$data?.constructor.name).toBe('SceneQueryRunner');
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
