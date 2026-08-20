import { FieldType, LoadingState, PanelData, toDataFrame, getDefaultTimeRange } from '@grafana/data';

import { barLabelsFitHorizontally, buildGeneratedPanel } from './buildPanel';
import { GeneratedPanelSpec } from './types';

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
    expect(barLabelsFitHorizontally(panelData(labels, labels.map((_, i) => i)))).toBe(false);
  });

  it('rejects a crowd of short labels', () => {
    const labels = Array.from({ length: 40 }, (_, i) => `P${i}`);
    expect(barLabelsFitHorizontally(panelData(labels, labels.map((_, i) => i)))).toBe(false);
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

describe('buildGeneratedPanel SQL gate', () => {
  const datasource = { uid: 'ch-uid', type: 'clickhouse' };
  const spec = (rawSql: string): GeneratedPanelSpec => ({ panelType: 'table', title: 'T', rawSql });

  it('builds a panel for a read-only query', () => {
    const panel = buildGeneratedPanel(spec('SELECT count() FROM stat.events'), datasource);
    expect(panel.state.pluginId).toBe('table');
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
