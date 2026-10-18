import { useEffect, useState } from 'react';
import { Button, Select } from '@substrat-run/ui';

/** Options for the client-side page-size control (the Scopes convention). */
export const PAGE_SIZES = [25, 50, 100];

export interface Paged<T> {
  rows: T[];
  total: number;
  start: number;
  page: number;
  pageCount: number;
  pageSize: number;
  setPageSize: (n: number) => void;
  setPage: (n: number) => void;
}

/** The page arithmetic: the page count, and the requested index clamped into range. */
export function pageWindow(total: number, pageSize: number, pageIndex: number) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.max(0, Math.min(pageIndex, pageCount - 1));
  return { pageCount, page, start: page * pageSize };
}

/**
 * Client-side paging over an already-filtered list. Resets to the first page when
 * `resetKey` changes (a filter or search edit can shrink the result below the current
 * page, and the operator must never land on an empty tail).
 */
export function usePaged<T>(items: T[], resetKey: string): Paged<T> {
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]!);
  const [pageIndex, setPage] = useState(0);
  useEffect(() => setPage(0), [resetKey, pageSize]);
  const total = items.length;
  const { pageCount, page, start } = pageWindow(total, pageSize, pageIndex);
  return {
    rows: items.slice(start, start + pageSize),
    total,
    start,
    page,
    pageCount,
    pageSize,
    setPageSize,
    setPage,
  };
}

/** The footer the Scopes table carries: range, page size, Prev/Next. */
export function Pager({ p }: { p: Paged<unknown> }) {
  if (p.total === 0) return null;
  return (
    <div
      style={{
        padding: '10px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        borderTop: '1px solid var(--border-subtle)',
        flexWrap: 'wrap',
      }}
    >
      <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
        Showing {p.start + 1}–{Math.min(p.start + p.pageSize, p.total)} of {p.total}
      </span>
      <Select
        size="sm"
        options={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} / page` }))}
        value={String(p.pageSize)}
        onChange={(e) => p.setPageSize(Number(e.target.value))}
        style={{ width: 110 }}
      />
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
        Page {p.page + 1} of {p.pageCount}
      </span>
      <Button variant="secondary" size="sm" disabled={p.page === 0} onClick={() => p.setPage(p.page - 1)}>
        Prev
      </Button>
      <Button variant="secondary" size="sm" disabled={p.page >= p.pageCount - 1} onClick={() => p.setPage(p.page + 1)}>
        Next
      </Button>
    </div>
  );
}
