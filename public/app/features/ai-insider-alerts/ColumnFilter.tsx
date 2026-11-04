// Analytix: AI Insider Alerts - filter a table by its columns. A magnifier
// with the column to search in ("All columns" by default), a text box that
// suggests the values the table actually has in that column (most rows
// first), and the picked values as removable chips. Typing filters as you go
// (substring); a picked suggestion is an exact match, so app version `5.1`
// does not also catch `5.10`. All conditions must hold.

import { css, cx } from '@emotion/css';
import { KeyboardEvent, useId, useMemo, useState } from 'react';

import { GrafanaTheme2 } from '@grafana/data';
import { t } from '@grafana/i18n';
import { Combobox, ComboboxOption, Icon, IconButton, Input, useStyles2 } from '@grafana/ui';
import { analytix } from 'app/features/home/analytixTokens';

import { formatCount } from './format';

export const ALL_COLUMNS = '*';
const SUGGESTIONS = 12;
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export interface FilterColumn<T> {
  key: string;
  label: string;
  /** The values of the cell (a cell may hold several: models, IPs). */
  values: (row: T) => Array<string | undefined>;
  /** Words shown next to a value and searched too (an error code's meaning). */
  hint?: (value: string, row: T) => string | undefined;
}

export interface FilterChip {
  column: string;
  value: string;
  /** Picked from the suggestions: the whole value must match, not a part. */
  exact: boolean;
}

export interface FilterSuggestion {
  column: string;
  columnLabel: string;
  value: string;
  hint?: string;
  /** Rows that have it. */
  rows: number;
}

function cellValues<T>(column: FilterColumn<T>, row: T): string[] {
  return column.values(row).flatMap((v) => (v && v.trim() ? [v.trim()] : []));
}

function chipMatches<T>(row: T, columns: Array<FilterColumn<T>>, chip: FilterChip): boolean {
  const q = chip.value.toLowerCase();
  const scope = chip.column === ALL_COLUMNS ? columns : columns.filter((c) => c.key === chip.column);
  return scope.some((c) =>
    cellValues(c, row).some((v) => {
      const value = v.toLowerCase();
      if (chip.exact) {
        return value === q;
      }
      return value.includes(q) || Boolean(c.hint?.(v, row)?.toLowerCase().includes(q));
    })
  );
}

/** The rows that meet every condition. */
export function filterRows<T>(rows: T[], columns: Array<FilterColumn<T>>, chips: FilterChip[]): T[] {
  const active = chips.filter((c) => c.value.trim());
  return active.length ? rows.filter((r) => active.every((chip) => chipMatches(r, columns, chip))) : rows;
}

/**
 * The values of a column (or of every column) that contain the text, with the
 * number of rows holding each: values starting with the text first, then the
 * most common. Values already picked are left out.
 */
export function columnSuggestions<T>(
  rows: T[],
  columns: Array<FilterColumn<T>>,
  column: string,
  text: string,
  picked: FilterChip[] = [],
  limit = SUGGESTIONS
): FilterSuggestion[] {
  const q = text.trim().toLowerCase();
  const scope = column === ALL_COLUMNS ? columns : columns.filter((c) => c.key === column);
  const taken = new Set(picked.filter((c) => c.exact).map((c) => `${c.column}\u0000${c.value.toLowerCase()}`));
  const found = new Map<string, FilterSuggestion>();
  for (const c of scope) {
    for (const row of rows) {
      const seen = new Set<string>();
      for (const v of cellValues(c, row)) {
        const lower = v.toLowerCase();
        if (seen.has(lower) || taken.has(`${c.key}\u0000${lower}`)) {
          continue;
        }
        seen.add(lower);
        const key = `${c.key}\u0000${lower}`;
        let s = found.get(key);
        if (!s) {
          const hint = c.hint?.(v, row);
          if (q && !lower.includes(q) && !hint?.toLowerCase().includes(q)) {
            continue;
          }
          s = { column: c.key, columnLabel: c.label, value: v, hint, rows: 0 };
          found.set(key, s);
        }
        s.rows++;
      }
    }
  }
  const starts = (s: FilterSuggestion) => (q && s.value.toLowerCase().startsWith(q) ? 0 : 1);
  return [...found.values()]
    .sort((a, b) => starts(a) - starts(b) || b.rows - a.rows || collator.compare(a.value, b.value))
    .slice(0, limit);
}

export interface ColumnFilterState {
  chips: FilterChip[];
  setChips: (chips: FilterChip[]) => void;
  column: string;
  setColumn: (column: string) => void;
  text: string;
  setText: (text: string) => void;
}

/** Filter state of one table and its rows: the chips plus the text being typed. */
export function useColumnFilter<T>(
  rows: T[],
  columns: Array<FilterColumn<T>>
): { filter: ColumnFilterState; rows: T[]; active: boolean } {
  const [chips, setChips] = useState<FilterChip[]>([]);
  const [column, setColumn] = useState(ALL_COLUMNS);
  const [text, setText] = useState('');
  const filtered = useMemo(
    () => filterRows(rows, columns, text.trim() ? [...chips, { column, value: text.trim(), exact: false }] : chips),
    [rows, columns, chips, column, text]
  );
  return {
    filter: { chips, setChips, column, setColumn, text, setText },
    rows: filtered,
    active: chips.length > 0 || text.trim() !== '',
  };
}

export function ColumnFilter<T>({
  filter,
  rows,
  columns,
  shown,
  className,
}: {
  filter: ColumnFilterState;
  /** All rows of the table: the suggestions come from them. */
  rows: T[];
  columns: Array<FilterColumn<T>>;
  /** Rows left after the filter, for the "N of M" note. */
  shown: number;
  className?: string;
}) {
  const styles = useStyles2(getStyles);
  const listId = useId();
  const { chips, setChips, column, setColumn, text, setText } = filter;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const columnOptions: Array<ComboboxOption<string>> = useMemo(
    () => [
      { value: ALL_COLUMNS, label: t('ai-insider-alerts.filter.all-columns', 'All columns') },
      ...columns.map((c) => ({ value: c.key, label: c.label })),
    ],
    [columns]
  );
  const labelOf = (key: string) =>
    key === ALL_COLUMNS ? t('ai-insider-alerts.filter.any', 'Any') : (columns.find((c) => c.key === key)?.label ?? key);

  // Suggest from the rows the chips leave, so every suggestion still finds something.
  const base = useMemo(() => filterRows(rows, columns, chips), [rows, columns, chips]);
  const suggestions = useMemo(
    () => (open ? columnSuggestions(base, columns, column, text, chips) : []),
    [open, base, columns, column, text, chips]
  );

  const addChip = (chip: FilterChip) => {
    setChips([...chips, chip]);
    setText('');
    setActive(-1);
  };
  const pick = (s: FilterSuggestion) => addChip({ column: s.column, value: s.value, exact: true });

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && suggestions[active]) {
        pick(suggestions[active]);
      } else if (text.trim()) {
        addChip({ column, value: text.trim(), exact: false });
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActive(-1);
    } else if (e.key === 'Backspace' && !text && chips.length) {
      setChips(chips.slice(0, -1));
    }
  };

  const columnLabel = column === ALL_COLUMNS ? undefined : labelOf(column).toLowerCase();
  const placeholder = columnLabel
    ? t('ai-insider-alerts.filter.placeholder-column', 'Type or pick a {{column}}…', {
        column: columnLabel,
        interpolation: { escapeValue: false },
      })
    : t('ai-insider-alerts.filter.placeholder', 'Type or pick a value…');

  return (
    <div className={cx(styles.bar, className)}>
      <div className={styles.query}>
        <div className={styles.column}>
          <Combobox
            prefixIcon="search"
            options={columnOptions}
            value={column}
            onChange={(o) => {
              setColumn(o.value);
              setActive(-1);
            }}
            width="auto"
            minWidth={16}
            aria-label={t('ai-insider-alerts.filter.column', 'Column to search in')}
          />
        </div>
        <div className={styles.valueBox}>
          <Input
            className={styles.value}
            value={text}
            placeholder={placeholder}
            onChange={(e) => {
              setText(e.currentTarget.value);
              setOpen(true);
              setActive(-1);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              setOpen(false);
              setActive(-1);
            }}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-label={t('ai-insider-alerts.filter.value', 'Value to search for')}
            aria-expanded={open && suggestions.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
          />
          {open && suggestions.length > 0 && (
            <ul id={listId} role="listbox" className={styles.menu}>
              {suggestions.map((s, i) => (
                <li
                  key={`${s.column}-${s.value}`}
                  role="option"
                  aria-selected={i === active}
                  className={cx(styles.option, i === active && styles.optionActive)}
                  // Pick before the input's blur closes the list.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(s);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  <span className={styles.optionText}>
                    <span className={styles.optionValue}>{s.value}</span>
                    {(s.hint || column === ALL_COLUMNS) && (
                      <span className={styles.optionHint}>
                        {[column === ALL_COLUMNS ? s.columnLabel : undefined, s.hint].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </span>
                  <span className={styles.optionCount}>{formatCount(s.rows)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {chips.map((chip, i) => (
        <span key={`${chip.column}-${chip.value}-${i}`} className={styles.chip}>
          <span className={styles.chipColumn}>{labelOf(chip.column)}</span>
          <span className={styles.chipValue}>{chip.exact ? chip.value : `“${chip.value}”`}</span>
          <IconButton
            name="times"
            size="sm"
            aria-label={t('ai-insider-alerts.filter.remove', 'Remove this condition')}
            onClick={() => setChips(chips.filter((_, j) => j !== i))}
          />
        </span>
      ))}
      {(chips.length > 0 || text.trim()) && (
        <>
          <span className={styles.count}>
            {t('ai-insider-alerts.viewers.filter-count', '{{shown}} of {{total}}', {
              shown: formatCount(shown),
              total: formatCount(rows.length),
            })}
          </span>
          <button
            type="button"
            className={styles.clear}
            onClick={() => {
              setChips([]);
              setText('');
            }}
          >
            <Icon name="times" size="sm" /> {t('ai-insider-alerts.filter.clear', 'Clear')}
          </button>
        </>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  bar: css({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.spacing(1),
  }),
  query: css({
    display: 'flex',
    alignItems: 'stretch',
    maxWidth: '100%',
  }),
  column: css({
    flex: '0 0 auto',
    // One control: the column picker and the text box share a border.
    '& input': {
      borderTopRightRadius: 'unset',
      borderBottomRightRadius: 'unset',
    },
  }),
  valueBox: css({
    position: 'relative',
    marginLeft: -1,
  }),
  value: css({
    width: 280,
    maxWidth: '100%',
    '& input': {
      borderTopLeftRadius: 'unset',
      borderBottomLeftRadius: 'unset',
    },
  }),
  menu: css({
    position: 'absolute',
    top: '100%',
    left: 0,
    zIndex: theme.zIndex.dropdown,
    minWidth: '100%',
    width: 'max-content',
    maxWidth: 520,
    maxHeight: 360,
    overflowY: 'auto',
    margin: theme.spacing(0.5, 0, 0),
    padding: theme.spacing(0.5, 0),
    listStyle: 'none',
    background: theme.colors.background.elevated,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    boxShadow: theme.shadows.z3,
  }),
  option: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing(2),
    padding: theme.spacing(0.5, 1.5),
    cursor: 'pointer',
  }),
  optionActive: css({
    background: theme.colors.action.hover,
  }),
  optionText: css({
    display: 'grid',
    minWidth: 0,
  }),
  optionValue: css({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  optionHint: css({
    color: analytix.textFaint,
    fontSize: 12,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  optionCount: css({
    color: analytix.textFaint,
    fontSize: 12,
    flex: '0 0 auto',
  }),
  chip: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    maxWidth: 360,
    padding: theme.spacing(0.25, 0.5, 0.25, 1),
    borderRadius: theme.shape.radius.pill,
    border: `1px solid ${analytix.borderControl}`,
    background: analytix.control,
    fontSize: 12,
  }),
  chipColumn: css({
    color: analytix.textFaint,
    flex: '0 0 auto',
  }),
  chipValue: css({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  count: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  clear: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    padding: 0,
    border: 'none',
    background: 'none',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    cursor: 'pointer',
    '&:hover': {
      color: theme.colors.text.primary,
    },
  }),
});
