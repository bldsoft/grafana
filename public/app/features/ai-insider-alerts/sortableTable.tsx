import { css, cx } from '@emotion/css';
import { ReactNode, ThHTMLAttributes, useMemo, useState } from 'react';

import { GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';

/** What a column sorts by: a number (times are unix seconds) or text. Empty values always go last. */
export type SortValue = string | number | boolean | null | undefined;
export type SortDirection = 'asc' | 'desc';
export type SortColumns<T> = Record<string, (row: T) => SortValue>;

export interface TableSort<K extends string> {
  key?: K;
  direction: SortDirection;
  toggle: (key: K) => void;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function isEmpty(value: SortValue): value is null | undefined | '' {
  return value === null || value === undefined || value === '' || (typeof value === 'number' && Number.isNaN(value));
}

function compareValues(a: SortValue, b: SortValue): number {
  const x = typeof a === 'boolean' ? Number(a) : a;
  const y = typeof b === 'boolean' ? Number(b) : b;
  if (typeof x === 'number' && typeof y === 'number') {
    return x - y;
  }
  // Numbers before text when a column mixes them.
  if (typeof x === 'number') {
    return -1;
  }
  if (typeof y === 'number') {
    return 1;
  }
  return collator.compare(String(x), String(y));
}

/** Stable sort by one accessor; empty values stay at the bottom in both directions. */
export function sortRows<T>(rows: T[], value: (row: T) => SortValue, direction: SortDirection): T[] {
  const sign = direction === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: value(row) }))
    .sort((a, b) => {
      const ae = isEmpty(a.value);
      const be = isEmpty(b.value);
      if (ae || be) {
        return ae === be ? a.index - b.index : ae ? 1 : -1;
      }
      return sign * compareValues(a.value, b.value) || a.index - b.index;
    })
    .map((entry) => entry.row);
}

/**
 * Click-to-sort for the hand-written result tables. The first click sorts
 * numbers and times from the largest and text from A, the second reverses,
 * the third returns to the engine's own order. Sorting happens before any
 * "first N rows" limit, so the limit shows the top of the sorted list.
 */
export function useTableSort<T, C extends SortColumns<T>>(
  rows: T[],
  columns: C
): { rows: T[]; sort: TableSort<Extract<keyof C, string>> } {
  type K = Extract<keyof C, string>;
  const [state, setState] = useState<{ key?: K; direction: SortDirection; first: SortDirection }>({
    direction: 'asc',
    first: 'asc',
  });

  const sorted = useMemo(() => {
    const value = state.key ? columns[state.key] : undefined;
    return value ? sortRows(rows, value, state.direction) : rows;
    // `columns` is usually an inline object literal: sorting follows the rows and the chosen column only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, state.key, state.direction]);

  const toggle = (key: K) => {
    setState((prev) => {
      if (prev.key !== key) {
        const sample = rows.map(columns[key]).find((v) => !isEmpty(v));
        const first: SortDirection = typeof sample === 'number' ? 'desc' : 'asc';
        return { key, direction: first, first };
      }
      if (prev.direction === prev.first) {
        return { ...prev, direction: prev.first === 'asc' ? 'desc' : 'asc' };
      }
      return { direction: 'asc', first: 'asc' };
    });
  };

  return { rows: sorted, sort: { key: state.key, direction: state.direction, toggle } };
}

type SortHeaderProps<K extends string> = {
  sort: TableSort<K>;
  column: K;
  children: ReactNode;
} & Omit<ThHTMLAttributes<HTMLTableCellElement>, 'children'>;

/** A `<th>` whose label sorts the table by `column`. */
export function SortHeader<K extends string>({ sort, column, children, ...rest }: SortHeaderProps<K>) {
  const styles = useStyles2(getStyles);
  const active = sort.key === column;
  const ariaSort = active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined;
  return (
    <th aria-sort={ariaSort} {...rest}>
      <button type="button" className={cx(styles.button, active && styles.active)} onClick={() => sort.toggle(column)}>
        {children}
        <Icon
          name={active && sort.direction === 'asc' ? 'arrow-up' : 'arrow-down'}
          size="xs"
          className={cx(styles.icon, !active && styles.idle)}
        />
      </button>
    </th>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  button: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    padding: 0,
    margin: 0,
    border: 0,
    background: 'none',
    font: 'inherit',
    color: 'inherit',
    textAlign: 'inherit',
    whiteSpace: 'inherit',
    cursor: 'pointer',
    '&:hover': {
      color: theme.colors.text.primary,
    },
    '&:hover > svg, &:focus-visible > svg': {
      opacity: 1,
    },
    '&:focus-visible': {
      outline: `2px solid ${theme.colors.primary.main}`,
      outlineOffset: 2,
      borderRadius: theme.shape.radius.default,
    },
  }),
  active: css({
    color: theme.colors.text.primary,
  }),
  icon: css({
    flexShrink: 0,
  }),
  // Takes its place even when hidden, so hovering a header never shifts the columns.
  idle: css({
    opacity: 0,
  }),
});
