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
 * Where a page's metadata rides on the WIRE (#829).
 *
 * The kernel-side shape is `Page<T>` above and stays that way — an operation is
 * transport-agnostic, and an in-process caller (a test, a seed, another
 * operation, an MCP tool) must be able to walk a list without an HTTP response to
 * read headers off. What changes is only the HTTP PROJECTION: the body is the
 * entries, and the walk is described in headers.
 *
 * **Because the alternative made adoption a breaking change.** Wrapping the body
 * renames a live endpoint's response — `[…]` or `{ customers: […] }` becomes
 * `{ entries: […] }` — and a vertical with API consumers it cannot see has no way
 * to soften that. The rational move was then to NOT adopt paging, which is the
 * opposite of what an unbounded list read deserves. In headers, a list endpoint
 * returns what it always returned and gains a walk; nobody's client breaks, and
 * the bare-array lists (which cannot carry a second key at all) adopt for free.
 *
 * `Link` rather than a bare cursor header: it is RFC 8288, it is what GitHub
 * serves, and it hands the client a URL to FOLLOW rather than one to assemble —
 * so the filter and page size travel with it automatically. The absence of a
 * `rel="next"` link is how the walk ends.
 *
 * Deliberately NOT `Content-Range: items 0-19/340`. That describes an OFFSET
 * window, and keyset paging does not know its offset — that ignorance is exactly
 * what keeps it correct while rows are being written. Emitting a start index
 * would be inventing a number.
 */
export const PAGE_LINK_HEADER = 'Link';

/** The opt-in total (`paged.total`), as a count — never a range. */
export const PAGE_TOTAL_HEADER = 'X-Total-Count';

/**
 * The headers a cross-origin browser client cannot read unless the server says
 * it may. Nothing in the platform sets CORS today (a vertical serves its app and
 * its API from one origin), so this exists for the vertical that opens its API to
 * browser callers and would otherwise ship a walk no browser can follow — a
 * failure that looks like "there is only one page".
 */
export const PAGE_EXPOSED_HEADERS = [PAGE_LINK_HEADER, PAGE_TOTAL_HEADER] as const;

/**
 * The `Link` header value for the next page, or null when the walk is over.
 *
 * Built from the REQUEST url so every other query parameter — the filters, the
 * page size, a declared sort — rides along untouched. Only `cursor` is replaced,
 * which is the one thing the client must not have to reassemble.
 */
export function nextPageLink(requestUrl: string, nextCursor: string | null): string | null {
  if (nextCursor === null) return null;
  const url = new URL(requestUrl);
  url.searchParams.set('cursor', nextCursor);
  return `<${url.toString()}>; rel="next"`;
}

/**
 * Is this an operation result the page projection applies to?
 *
 * Structural, and checked rather than assumed: a paged operation whose handler
 * returns something else (mid-refactor, or a vertical that declared `paged` and
 * has not adopted `pageOf` yet) must reach the client unchanged rather than be
 * silently emptied into a body of `undefined`.
 */
export function isPage(value: unknown): value is Page<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as Page<unknown>).entries) &&
    'nextCursor' in value
  );
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
