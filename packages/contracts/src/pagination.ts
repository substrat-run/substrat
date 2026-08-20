import { z } from 'zod';

/**
 * The ONE pagination convention for every list read on the platform (#458-shape
 * work): keyset ("cursor") pages over the list's own sort key, `{ entries,
 * nextCursor }` out. Grown from the admin-log read (`AuditLogFilter` /
 * `GET /admin-log`), which shipped it first; everything else now follows.
 *
 * Two layers, deliberately different defaults (the admin-log precedent):
 * - **Kernel/adapter reads** (`HostAdmin.list*`) take an optional `ListPage`;
 *   unset means UNBOUNDED, because internal callers (provisioning, catalogs,
 *   sweeps) mean "everything" and a silent cap would let them mistake a page
 *   for the whole set.
 * - **HTTP list routes** DEFAULT a page (`LIST_PAGE_DEFAULT`) — the egress is
 *   where an ever-growing table must stop being a dump. UIs walk with `cursor`.
 *
 * The cursor is the last entry's sort key verbatim (ULID id, slug, hostname…)
 * — chronological where the key is a ULID, lexicographic otherwise — so it
 * needs no encoding and survives in a query string. A composite sort key joins
 * its parts with `|` (first part always `|`-free: a ULID or enum).
 */

/** Default page size on every HTTP list read. */
export const LIST_PAGE_DEFAULT = 20;
/** Hard ceiling on a requested page — same order as a table page (§ introspection). */
export const LIST_PAGE_MAX = 200;

/**
 * Query-string shape of every paged HTTP list read. `order` flips the walk
 * direction where the route supports it (each route documents its default —
 * existing routes keep the order they shipped with).
 */
export const listPageQuery = z.object({
  limit: z.coerce.number().int().positive().max(LIST_PAGE_MAX).default(LIST_PAGE_DEFAULT),
  cursor: z.string().min(1).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});
export type ListPageQuery = z.infer<typeof listPageQuery>;

/**
 * Kernel-side page params, foldable into any list filter. Unset `limit` means
 * unbounded (see above). `cursor` is exclusive: entries strictly after it in
 * `asc` order, strictly before it in `desc`.
 */
export interface ListPage {
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
}

/** The envelope every paged HTTP list read returns. */
export interface Page<T> {
  entries: T[];
  nextCursor: string | null;
}

/**
 * A page that also knows how many rows the walk covers — `1–20 of 340`.
 *
 * Opt-in per operation, because it is not free: keyset paging gives no total for
 * free (that is the trade for correctness under concurrent writes), so a total is a
 * SECOND query on every request. Business software asks for it constantly — a list
 * of work orders or invoices with no count reads as broken to an office admin — so
 * the platform supports it rather than pretending nobody needs it. It just refuses
 * to charge every list for it.
 *
 * `total` counts the FILTERED set — the same `WHERE` the page ran under, never the
 * table. A count of the whole table beside a filtered page is a number that is
 * wrong in a way nobody notices until a customer does.
 *
 * It is also a snapshot: rows may be inserted or deleted mid-walk, so a total read
 * on page one can disagree with the rows eventually seen. That is inherent to
 * counting a moving set, not a defect to design around.
 */
export interface CountedPage<T> extends Page<T> {
  total: number;
}

/**
 * Wrap a just-read page. `nextCursor` is the last entry's sort key when the
 * page came back full (there MAY be more), null when it came back short (the
 * walk is done — no trailing empty fetch).
 */
export function pageOf<T>(entries: T[], limit: number, key: (entry: T) => string): Page<T> {
  const last = entries.length >= limit ? entries[entries.length - 1] : undefined;
  return { entries, nextCursor: last === undefined ? null : key(last) };
}

/**
 * Wrap a page that carries a total. `total` must come from a count over the SAME
 * filter the page ran under — see `CountedPage`.
 */
export function countedPageOf<T>(
  entries: T[],
  limit: number,
  key: (entry: T) => string,
  total: number,
): CountedPage<T> {
  return { ...pageOf(entries, limit, key), total };
}

/**
 * The Zod shape of a page of `entry` — what a paged operation actually returns.
 *
 * Built from the entry schema rather than declared beside it, so a vertical states
 * the entry once and the envelope cannot drift from `pageOf`'s output. The emitted
 * OpenAPI uses this same builder, which is what keeps the document and the handler
 * describing one thing (D-22).
 */
export function pageSchema<T extends z.ZodType>(entry: T, withTotal = false) {
  const base = z.object({
    entries: z.array(entry),
    /** The cursor to pass back for the next page, or `null` when the walk is done. */
    nextCursor: z.string().nullable(),
  });
  return withTotal
    ? base.extend({
        /** Rows matching this list's filter, counted at the time of this page. */
        total: z.number().int().nonnegative(),
      })
    : base;
}
