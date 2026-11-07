import { Fragment } from 'react';
import { vi } from 'vitest';
import type { TableProps } from '@substrat-run/ui/wa';

/**
 * No element is registered in a suite: a `wa-*` tag stays a plain element holding its light
 * DOM, which is what a suite here reads, and whether Web Awesome draws it right is a
 * browser's to show. `<sub-entity-table>` is the exception, since it draws its rows itself,
 * so a plain table stands in for the `Table` around it.
 */
vi.mock('@substrat-run/ui/wa', async (real) => ({
  ...(await real<object>()),
  Table: <T,>({ columns, rows, onRowClick, emptyText = 'Nothing here yet.', rowKey, detail, expanded }: TableProps<T>) => (
    <table>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.header}>{c.header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td>{emptyText}</td>
          </tr>
        )}
        {rows.map((row, i) => {
          const id = rowKey?.(row) ?? String(i);
          return (
            <Fragment key={id}>
              <tr data-row={id} onClick={onRowClick && (() => onRowClick(row, i))}>
                {columns.map((c) => (
                  <td key={c.header}>{c.render ? c.render(row, i) : c.key ? String(row[c.key] ?? '') : null}</td>
                ))}
              </tr>
              {detail && expanded === id && (
                <tr>
                  <td colSpan={columns.length}>{detail(row)}</td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  ),
}));
