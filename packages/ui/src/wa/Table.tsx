import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { CellHandle, Column, Page, SubEntityTable, TableSource } from '@substrat-run/elements';

export interface TableColumn<T> {
  header: string;
  key?: keyof T & string;
  render?: (row: T, index: number) => ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Geist Mono at 12.5px, for ids, slugs, timestamps. */
  mono?: boolean;
  /** Tertiary text colour. */
  muted?: boolean;
  width?: number | string;
}

export interface TableProps<T> {
  columns: TableColumn<T>[];
  /** The rows to show: the whole list a view holds, not a page. */
  rows: T[];
  onRowClick?: (row: T, index: number) => void;
  emptyText?: string;
  /** The table's accessible name. */
  label?: string;
  /** Show the rows a page at a time, with the table's own pager. */
  paged?: boolean;
  /** Back to the first page when this changes: a filter can shrink the list under the page. */
  resetKey?: string;
  /** Needed with `expanded`, which names a row by it. Otherwise a row is its place in `rows`. */
  rowKey?: (row: T) => string;
  /** The open row's detail, drawn under it across the table. */
  detail?: (row: T) => ReactNode;
  /** The `rowKey` of the row whose `detail` is open. */
  expanded?: string | undefined;
  style?: CSSProperties;
}

/** A row as the table holds it: the table keys a row by `id`, and a view's row may not have one. */
interface Line<T> {
  id: string;
  index: number;
  row: T;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'sub-entity-table': React.DetailedHTMLProps<React.HTMLAttributes<SubEntityTable>, SubEntityTable> & {
        label?: string | undefined;
        empty?: string;
        paging?: 'pages' | 'more';
        'row-click'?: boolean | undefined;
      };
    }
  }
}

/** A page of `lines`. `next` is where the following page starts, and how long it is. */
function pageOf<T>(lines: Line<T>[], offset: number, limit: number | null, paged: boolean): Page<Line<T>> {
  if (!paged || limit === null) return { entries: lines, next: null, total: null };
  const end = offset + limit;
  return { entries: lines.slice(offset, end), next: end < lines.length ? `${end}:${limit}` : null, total: lines.length };
}

/**
 * The rows the view already holds, read the way the table reads a paged route, so a walk
 * through them is its pager and not a second one here. `pageOf` reads the list as it is at
 * each read, which is what makes `reload()` show a changed list.
 */
function sourceOver<T>(lines: () => Line<T>[], paged: boolean): TableSource<Line<T>> {
  return {
    read: (query) => Promise.resolve(pageOf(lines(), 0, query.limit, paged)),
    follow: (next) => {
      const [offset, limit] = next.split(':').map(Number);
      return Promise.resolve(pageOf(lines(), offset!, limit!, paged));
    },
  };
}

const ALIGN = { left: 'start', right: 'end' } as const;

/**
 * `<sub-entity-table>` over rows a view holds. A cell is a React root of its own, because a
 * React `stopPropagation` in a cell then stops at the cell, before the row's click. Every
 * render of the view paints the cells again: a cell's closure holds the view's state.
 */
export function Table<T>({
  columns,
  rows,
  onRowClick,
  emptyText = 'Nothing here yet.',
  label,
  paged = false,
  resetKey,
  rowKey,
  detail,
  expanded,
  style,
}: TableProps<T>) {
  const table = useRef<SubEntityTable<Line<T>>>(null);
  const latest = useRef({ columns, detail, onRowClick, rowKey });
  latest.current = { columns, detail, onRowClick, rowKey };
  const lines = useRef<Line<T>[]>([]);
  lines.current = rows.map((row, index) => ({ id: rowKey?.(row) ?? String(index), index, row }));
  const painted = useRef(new Set<() => void>());

  /** Draw into `cell` with React, and keep it painted until the table lets go of it. */
  const mounting =
    (draw: (line: Line<T>) => ReactNode) =>
    (cell: HTMLElement, first: Line<T>): CellHandle<Line<T>> => {
      const root = createRoot(cell);
      let line = first;
      const paint = () => root.render(draw(line));
      paint();
      painted.current.add(paint);
      return {
        update: (next) => {
          line = next;
          paint();
        },
        // Deferred: leaving a screen unmounts the table inside React's own render.
        unmount: () => {
          painted.current.delete(paint);
          queueMicrotask(() => root.unmount());
        },
      };
    };

  const shape = columns.map((c) => `${c.header}|${c.align}|${c.width}`).join('\u0000');
  useEffect(() => {
    const el = table.current!;
    el.columns = columns.map((c, i): Column<Line<T>> => {
      const align = c.align === 'left' || c.align === 'right' ? ALIGN[c.align] : undefined;
      return {
        key: `c${i}`,
        label: c.header,
        ...(align ? { align } : {}),
        ...(c.width !== undefined ? { width: typeof c.width === 'number' ? `${c.width}px` : c.width } : {}),
        mount: mounting((line) => {
          const now = latest.current.columns[i];
          if (!now) return null;
          return (
            <span
              style={{
                fontFamily: now.mono ? 'var(--font-mono)' : undefined,
                fontSize: now.mono ? 'var(--text-sm)' : undefined,
                color: now.muted ? 'var(--text-tertiary)' : undefined,
                textAlign: now.align,
                width: now.align === 'center' ? '100%' : undefined,
              }}
            >
              {now.render ? now.render(line.row, line.index) : now.key ? String(line.row[now.key] ?? '') : null}
            </span>
          );
        }),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `shape` is what `columns` means here
  }, [shape]);

  const hasDetail = !!detail;
  useEffect(() => {
    table.current!.detail = hasDetail ? mounting((line) => latest.current.detail?.(line.row)) : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `mounting` only reads refs
  }, [hasDetail]);

  useEffect(() => {
    table.current!.expanded = expanded ?? null;
  }, [expanded]);

  useEffect(() => {
    const el = table.current!;
    const click = (e: Event) => {
      const { row: line } = (e as CustomEvent<{ row: Line<T> }>).detail;
      latest.current.onRowClick?.(line.row, line.index);
    };
    el.addEventListener('sub-row-click', click);
    return () => el.removeEventListener('sub-row-click', click);
  }, []);

  // A new source starts the walk over; `query` keeps the page size chosen so far.
  useEffect(() => {
    const el = table.current!;
    if (el.currentQuery) el.query = el.currentQuery;
    el.source = sourceOver(() => lines.current, paged);
  }, [resetKey, paged]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else void table.current!.reload();
  }, [rows]);

  useEffect(() => {
    for (const paint of painted.current) paint();
  });

  return (
    <sub-entity-table
      ref={table as never}
      label={label}
      empty={emptyText}
      paging={paged ? 'pages' : 'more'}
      row-click={onRowClick ? true : undefined}
      style={style}
    />
  );
}
