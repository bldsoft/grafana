import { FieldType, toDataFrame } from '@grafana/data';

import { canExportImage, exportFileName, guardCsvInjection } from './exportPanel';

describe('canExportImage', () => {
  it('is true for the canvas (uPlot) panel types', () => {
    expect(canExportImage('timeseries')).toBe(true);
    expect(canExportImage('barchart')).toBe(true);
  });

  it('is false for DOM/SVG panel types (no client-side rasterizer)', () => {
    expect(canExportImage('table')).toBe(false);
    expect(canExportImage('piechart')).toBe(false);
    expect(canExportImage('stat')).toBe(false);
  });
});

describe('exportFileName', () => {
  it('sanitizes unsafe characters out of the title', () => {
    const name = exportFileName('Watch time / by content!');
    expect(name).toMatch(/^Watch_time_by_content-/);
    expect(name).not.toMatch(/[/!\s]/);
  });

  it('falls back to "panel" for blank titles', () => {
    expect(exportFileName('   ')).toMatch(/^panel-/);
    expect(exportFileName('')).toMatch(/^panel-/);
  });

  it('caps an overlong title to 80 chars before the timestamp', () => {
    const name = exportFileName('a'.repeat(200));
    expect(name.split('-')[0].length).toBe(80);
  });

  it('strips a leading dot so the download is not a hidden file', () => {
    expect(exportFileName('.config')).toMatch(/^config-/);
    expect(exportFileName('../../etc/passwd')).not.toMatch(/[/.]{2}/);
  });
});

describe('guardCsvInjection', () => {
  const frame = (labels: unknown[], values: number[]) =>
    toDataFrame({
      fields: [
        { name: 'label', type: FieldType.string, values: labels },
        { name: 'value', type: FieldType.number, values },
      ],
    });

  it('prefixes string cells that start with a formula lead character', () => {
    const [out] = guardCsvInjection([frame(['=HYPERLINK("http://x")', '+1', '-cmd', '@SUM', 'ok'], [1, 2, 3, 4, 5])]);
    expect(out.fields[0].values).toEqual([`'=HYPERLINK("http://x")`, `'+1`, `'-cmd`, `'@SUM`, 'ok']);
  });

  it('leaves numeric fields (incl. negative numbers) untouched', () => {
    const [out] = guardCsvInjection([frame(['ok'], [-5])]);
    expect(out.fields[1].values).toEqual([-5]);
  });
});
