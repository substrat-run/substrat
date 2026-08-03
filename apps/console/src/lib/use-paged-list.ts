import { useCallback, useEffect, useRef, useState } from 'react';
import { LIST_PAGE_DEFAULT, LIST_PAGE_MAX } from '@substrat-run/contracts';
import type { Page } from '@substrat-run/contracts';

/**
 * The AdminLog pattern (PAGE-sized first read, a footer button that appends the
 * next cursor page, `nextCursor === null` = exhausted), generalized so every list
 * view walks its table the same way instead of re-deriving the loop.
 *
 * What it deliberately is NOT: a cache of the whole list. Aggregates that need
 * the FULL set (fleet counts, cascade status, dropdowns) keep using `walkAll`
 * (lib/api.ts) — this hook only feeds a table that grows a page at a time.
 */

/** One page-fetch — every paged `Api` list method fits this shape. */
export type FetchPage<T> = (page: { limit: number; cursor?: string }) => Promise<Page<T>>;

export interface PagedList<T> {
  entries: T[];
  /** Non-null = there MAY be more (pagination.ts); the Load-more button's condition. */
  nextCursor: string | null;
  loadMore: () => Promise<void>;
}

/**
 * `deps` reloads from the top when they change — pass the api plus whatever
 * signals a mutation (the app-level array a `load()` refresh replaces works: its
 * identity changes per refresh). A reload keeps the already-loaded window (capped
 * at `LIST_PAGE_MAX`, one request) so a mutation on page 3 does not snap the
 * table back to page 1. `onError` mirrors each view's existing toast path.
 */
export function usePagedList<T>(
  fetchPage: FetchPage<T>,
  deps: readonly unknown[],
  onError?: (e: Error) => void,
): PagedList<T> {
  const [entries, setEntries] = useState<T[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  // Latest closures without retriggering the effect; a sequence number drops
  // out-of-order responses (the AdminLog `live` flag, race-proofed for appends).
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const seq = useRef(0);

  useEffect(() => {
    const mySeq = ++seq.current;
    const limit = Math.min(LIST_PAGE_MAX, Math.max(LIST_PAGE_DEFAULT, entriesRef.current.length));
    void fetchRef
      .current({ limit })
      .then((page) => {
        if (seq.current !== mySeq) return;
        setEntries(page.entries);
        setNextCursor(page.nextCursor);
      })
      .catch((e: unknown) => errorRef.current?.(e as Error));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-owned deps, by design
  }, deps);

  const loadMore = useCallback(async () => {
    if (nextCursor === null) return;
    const mySeq = ++seq.current;
    try {
      const page = await fetchRef.current({ limit: LIST_PAGE_DEFAULT, cursor: nextCursor });
      if (seq.current !== mySeq) return;
      setEntries((prev) => [...prev, ...page.entries]);
      setNextCursor(page.nextCursor);
    } catch (e) {
      errorRef.current?.(e as Error);
    }
  }, [nextCursor]);

  return { entries, nextCursor, loadMore };
}
