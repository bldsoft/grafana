import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { navTreeReducer, setAiInsiderAlertsNav } from 'app/core/reducers/navBarTree';

import { buildAlertsNav } from './nav';
import { SortHeader, sortRows, useTableSort } from './sortableTable';

interface Row {
  name: string;
  count?: number;
}

const ROWS: Row[] = [
  { name: 'Sport 10', count: 3 },
  { name: 'sport 2', count: undefined },
  { name: 'News', count: 12 },
  { name: 'Kids', count: 3 },
];

describe('sortRows', () => {
  it('sorts numbers and keeps empty values last in both directions', () => {
    expect(sortRows(ROWS, (r) => r.count, 'desc').map((r) => r.name)).toEqual(['News', 'Sport 10', 'Kids', 'sport 2']);
    expect(sortRows(ROWS, (r) => r.count, 'asc').map((r) => r.name)).toEqual(['Sport 10', 'Kids', 'News', 'sport 2']);
  });

  it('sorts text case-insensitively with numbers inside compared as numbers', () => {
    expect(sortRows(ROWS, (r) => r.name, 'asc').map((r) => r.name)).toEqual(['Kids', 'News', 'sport 2', 'Sport 10']);
  });
});

function Table({ rows }: { rows: Row[] }) {
  const { rows: sorted, sort } = useTableSort(rows, { name: (r) => r.name, count: (r) => r.count });
  return (
    <table>
      <thead>
        <tr>
          <SortHeader sort={sort} column="name">
            Name
          </SortHeader>
          <SortHeader sort={sort} column="count">
            Count
          </SortHeader>
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
          <tr key={r.name}>
            <td>{r.name}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const names = () =>
  within(screen.getAllByRole('rowgroup')[1])
    .getAllByRole('row')
    .map((row) => row.textContent);

describe('useTableSort', () => {
  it('cycles a number column largest first, then smallest first, then the original order', async () => {
    const user = userEvent.setup();
    render(<Table rows={ROWS} />);
    const count = screen.getByRole('button', { name: 'Count' });

    await user.click(count);
    expect(names()).toEqual(['News', 'Sport 10', 'Kids', 'sport 2']);
    expect(screen.getByRole('columnheader', { name: 'Count' })).toHaveAttribute('aria-sort', 'descending');

    await user.click(count);
    expect(names()).toEqual(['Sport 10', 'Kids', 'News', 'sport 2']);
    expect(screen.getByRole('columnheader', { name: 'Count' })).toHaveAttribute('aria-sort', 'ascending');

    await user.click(count);
    expect(names()).toEqual(ROWS.map((r) => r.name));
    expect(screen.getByRole('columnheader', { name: 'Count' })).not.toHaveAttribute('aria-sort');
  });

  it('starts a text column from A', async () => {
    const user = userEvent.setup();
    render(<Table rows={ROWS} />);
    await user.click(screen.getByRole('button', { name: 'Name' }));
    expect(names()).toEqual(['Kids', 'News', 'sport 2', 'Sport 10']);
  });
});

describe('setAiInsiderAlertsNav', () => {
  const tree = [
    { id: 'home', text: 'Home' },
    { id: 'dashboards', text: 'Dashboards' },
    { id: 'explore', text: 'Explore' },
  ];

  it('puts the section with its two sub-items right after Dashboards, once', () => {
    let state = navTreeReducer(tree, setAiInsiderAlertsNav(buildAlertsNav()));
    state = navTreeReducer(state, setAiInsiderAlertsNav(buildAlertsNav()));
    expect(state.map((item) => item.id)).toEqual(['home', 'dashboards', 'ai-insider-alerts', 'explore']);
    expect(state[2].children?.map((item) => item.url)).toEqual([
      '/ai-insider/alerts',
      '/ai-insider/alerts?section=keep',
    ]);
  });

  it('removes the section when access is gone', () => {
    const state = navTreeReducer(tree, setAiInsiderAlertsNav(buildAlertsNav()));
    expect(navTreeReducer(state, setAiInsiderAlertsNav(undefined)).map((item) => item.id)).toEqual([
      'home',
      'dashboards',
      'explore',
    ]);
  });
});
