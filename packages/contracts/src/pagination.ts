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
 * Wrap a just-read page. `nextCursor` is the last entry's sort key when the
 * page came back full (there MAY be more), null when it came back short (the
 * walk is done — no trailing empty fetch).
 */
export function pageOf<T>(entries: T[], limit: number, key: (entry: T) => string): Page<T> {
  const last = entries.length >= limit ? entries[entries.length - 1] : undefined;
  return { entries, nextCursor: last === undefined ? null : key(last) };
}

/**
 * The Zod shape of a page of `entry` — what a paged operation actually returns.
 *
 * Built from the entry schema rather than declared beside it, so a vertical states
 * the entry once and the envelope cannot drift from `pageOf`'s output. The emitted
 * OpenAPI uses this same builder, which is what keeps the document and the handler
 * describing one thing (D-22).
 */
export function pageSchema<T extends z.ZodType>(entry: T) {
  return z.object({
    entries: z.array(entry),
    /** The cursor to pass back for the next page, or `null` when the walk is done. */
    nextCursor: z.string().nullable(),
  });
}
