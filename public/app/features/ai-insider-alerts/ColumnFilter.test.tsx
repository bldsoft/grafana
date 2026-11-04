import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  ALL_COLUMNS,
  ColumnFilter,
  FilterColumn,
  columnSuggestions,
  filterRows,
  useColumnFilter,
} from './ColumnFilter';

interface Row {
  platform: string;
  models: string[];
  code: string;
}

const rows: Row[] = [
  { platform: 'iOS', models: ['iPhone 15'], code: '403' },
  { platform: 'iOS', models: ['iPhone 13', 'iPad'], code: '403' },
  { platform: 'tvOS', models: ['Apple TV'], code: '2001' },
  { platform: 'Android', models: ['Mi Box'], code: '' },
];

const columns: Array<FilterColumn<Row>> = [
  { key: 'platform', label: 'Platform', values: (r) => [r.platform] },
  { key: 'model', label: 'Model', values: (r) => r.models },
  {
    key: 'error',
    label: 'Error',
    values: (r) => [r.code],
    hint: (code) => (code === '403' ? 'Forbidden' : undefined),
  },
];

describe('column filter', () => {
  it('suggests the values of a column, most rows first, starting matches first', () => {
    expect(columnSuggestions(rows, columns, 'platform', '').map((s) => [s.value, s.rows])).toEqual([
      ['iOS', 2],
      ['Android', 1],
      ['tvOS', 1],
    ]);
    // "os" is in both Apple values; neither starts with it, so the count decides.
    expect(columnSuggestions(rows, columns, 'platform', 'os').map((s) => s.value)).toEqual(['iOS', 'tvOS']);
    expect(columnSuggestions(rows, columns, 'platform', 'tv').map((s) => s.value)).toEqual(['tvOS']);
  });

  it('searches every column and the hints in "All columns", leaving picked values out', () => {
    const found = columnSuggestions(rows, columns, ALL_COLUMNS, 'forbid');
    expect(found).toEqual([{ column: 'error', columnLabel: 'Error', value: '403', hint: 'Forbidden', rows: 2 }]);
    const picked = columnSuggestions(rows, columns, 'platform', '', [
      { column: 'platform', value: 'ios', exact: true },
    ]);
    expect(picked.map((s) => s.value)).toEqual(['Android', 'tvOS']);
  });

  it('matches a picked value exactly and typed text as a part, every condition at once', () => {
    expect(filterRows(rows, columns, [{ column: 'platform', value: 'iOS', exact: true }])).toHaveLength(2);
    expect(filterRows(rows, columns, [{ column: 'platform', value: 'os', exact: false }])).toHaveLength(3);
    expect(filterRows(rows, columns, [{ column: 'platform', value: 'os', exact: true }])).toHaveLength(0);
    expect(
      filterRows(rows, columns, [
        { column: 'platform', value: 'iOS', exact: true },
        { column: 'model', value: 'ipad', exact: false },
      ])
    ).toEqual([rows[1]]);
    expect(filterRows(rows, columns, [{ column: ALL_COLUMNS, value: 'forbidden', exact: false }])).toHaveLength(2);
    expect(filterRows(rows, columns, [])).toBe(rows);
  });
});

function Harness() {
  const { filter, rows: shown } = useColumnFilter(rows, columns);
  return (
    <>
      <ColumnFilter filter={filter} rows={rows} columns={columns} shown={shown.length} />
      <ul aria-label="rows">
        {shown.map((r, i) => (
          <li key={i}>{r.models.join(',')}</li>
        ))}
      </ul>
    </>
  );
}

describe('ColumnFilter', () => {
  it('suggests table values while typing, and a picked one becomes a removable chip', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const box = screen.getByRole('combobox', { name: 'Value to search for' });
    await user.click(box);
    // "All columns": every column's values, with the column named.
    expect(screen.getAllByRole('option').length).toBeGreaterThan(3);

    await user.type(box, 'forb');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('403');
    expect(options[0]).toHaveTextContent('Error · Forbidden');
    // Typing filters already, before anything is picked.
    expect(screen.getByLabelText('rows').children).toHaveLength(2);

    await user.keyboard('{ArrowDown}{Enter}');
    expect(box).toHaveValue('');
    expect(screen.getByText('2 of 4')).toBeInTheDocument();
    expect(screen.getByLabelText('rows').children).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Remove this condition' }));
    expect(screen.getByLabelText('rows').children).toHaveLength(4);
  });
});
