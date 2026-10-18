import type { TraceHead } from '@substrat-run/contracts';
import {
  ConsoleQueryError,
  DEFAULT_PAGE,
  FACET_KEYS,
  FACET_TOP,
  MAX_PAGE,
  type FacetKey,
  type FacetValue,
  type RequestFacets,
  type RequestPage,
  type RequestQuery,
  type RequestWhere,
} from './source.js';

/**
 * The query semantics, over requests held in memory. Pure, and the one reading of a
 * `RequestQuery`: the local source answers through it, and so can any source that holds its
 * requests as a list.
 */

/** Refuse a query that is not a window. */
export function assertQuery(query: RequestQuery): void {
  if (!Number.isFinite(query.from) || !Number.isFinite(query.to) || query.from > query.to) {
    throw new ConsoleQueryError(`not a window: from ${query.from} to ${query.to}`);
  }
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1)) {
    throw new ConsoleQueryError(`not a page size: ${query.limit}`);
  }
}

const startedMs = (head: TraceHead): number => Date.parse(head.startedAt);

/** The text a facet value is filtered and counted as; `null` when the request has none. */
export function facetValueOf(head: TraceHead, key: FacetKey): string | null {
  const v = head[key];
  return v === null ? null : String(v);
}

/** The request matches every key of `where`, `omit` left out. */
export function matchesWhere(head: TraceHead, where: RequestWhere | undefined, omit?: FacetKey): boolean {
  for (const key of FACET_KEYS) {
    if (key === omit) continue;
    const wanted = where?.[key];
    if (!wanted || wanted.length === 0) continue;
    const v = facetValueOf(head, key);
    if (v === null || !wanted.includes(v)) return false;
  }
  return true;
}

/** Inside `[from, to)` on its start. A request whose `startedAt` does not parse is in no window. */
export function inWindow(head: TraceHead, query: Pick<RequestQuery, 'from' | 'to'>): boolean {
  const t = startedMs(head);
  return Number.isFinite(t) && t >= query.from && t < query.to;
}

/** Newest first; a tie on the instant is broken by id, so the order is total and pages never overlap. */
export function newestFirst(a: TraceHead, b: TraceHead): number {
  return startedMs(b) - startedMs(a) || (a.invocationId < b.invocationId ? 1 : a.invocationId > b.invocationId ? -1 : 0);
}

const CURSOR = /^c1:(-?\d+):(.+)$/;

/** A keyset cursor: the last request's position, so a request arriving mid-walk shifts nothing. */
function cursorOf(head: TraceHead): string {
  return `c1:${startedMs(head)}:${head.invocationId}`;
}

function readCursor(cursor: string): { ms: number; id: string } {
  const m = CURSOR.exec(cursor);
  if (!m) throw new ConsoleQueryError(`not a cursor this source wrote: ${cursor}`);
  return { ms: Number(m[1]), id: m[2] as string };
}

/** Strictly older than the cursor's position in {@link newestFirst} order. */
function after(head: TraceHead, at: { ms: number; id: string }): boolean {
  const t = startedMs(head);
  return t < at.ms || (t === at.ms && head.invocationId < at.id);
}

/** The requests a query matches, every page of them, newest first. */
export function matching(heads: Iterable<TraceHead>, query: RequestQuery, omit?: FacetKey): TraceHead[] {
  const out: TraceHead[] = [];
  for (const h of heads) if (inWindow(h, query) && matchesWhere(h, query.where, omit)) out.push(h);
  return out.sort(newestFirst);
}

/** One page of a query. */
export function pageOf(heads: Iterable<TraceHead>, query: RequestQuery): RequestPage {
  assertQuery(query);
  const limit = Math.min(query.limit ?? DEFAULT_PAGE, MAX_PAGE);
  const at = query.cursor === undefined ? undefined : readCursor(query.cursor);
  const rest = matching(heads, query).filter((h) => at === undefined || after(h, at));
  const requests = rest.slice(0, limit);
  const last = requests[requests.length - 1];
  return { requests, nextCursor: rest.length > limit && last ? cursorOf(last) : null };
}

/** Exact facet counts of a query, each key counted with its own filter left out. */
export function facetsOf(heads: readonly TraceHead[], query: RequestQuery): RequestFacets {
  assertQuery(query);
  const facets = {} as Record<FacetKey, FacetValue[]>;
  for (const key of FACET_KEYS) {
    const counts = new Map<string, number>();
    for (const h of matching(heads, query, key)) {
      const v = facetValueOf(h, key);
      if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    facets[key] = [...counts]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
      .slice(0, FACET_TOP);
  }
  return { total: matching(heads, query).length, facets, estimated: false };
}
