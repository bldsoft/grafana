import { parseSpec } from './generatePanelSpec';

describe('parseSpec', () => {
  it('parses a clean JSON object', () => {
    const spec = parseSpec(
      JSON.stringify({
        panelType: 'piechart',
        title: 'Last 30 days',
        rawSql: 'SELECT category, count() FROM events GROUP BY category',
        timeFrom: 'now-30d',
        timeTo: 'now',
      })
    );

    expect(spec).toEqual({
      panelType: 'piechart',
      title: 'Last 30 days',
      rawSql: 'SELECT category, count() FROM events GROUP BY category',
      timeFrom: 'now-30d',
      timeTo: 'now',
    });
  });

  it('strips markdown fences and surrounding prose', () => {
    const reply = 'Here you go:\n```json\n{"panelType":"table","rawSql":"SELECT 1"}\n```\nHope that helps!';
    const spec = parseSpec(reply);

    expect(spec.panelType).toBe('table');
    expect(spec.rawSql).toBe('SELECT 1');
    // Falls back to a default title when none is provided.
    expect(spec.title).toBe('AI panel');
  });

  it('throws on an unsupported panel type', () => {
    expect(() => parseSpec('{"panelType":"heatmap","rawSql":"SELECT 1"}')).toThrow(/Unsupported panel type/);
  });

  it('throws when the SQL is missing', () => {
    expect(() => parseSpec('{"panelType":"stat"}')).toThrow(/missing a SQL query/);
  });

  it('throws on non-JSON replies', () => {
    expect(() => parseSpec('I cannot help with that.')).toThrow(/did not return valid JSON/);
  });
});
