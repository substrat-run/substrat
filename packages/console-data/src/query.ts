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

// The query semantics, over requests held in memory. Pure, and the one reading of a
// `RequestQuery`: the local source answers through it, and so can any source that holds its
// requests as a list.

/** Refuse a query that is not a window. */
function assertQuery(query: RequestQuery): void {
  if (!Number.isFinite(query.from) || !Number.isFinite(query.to) || query.from > query.to) {
    throw new ConsoleQueryError(`not a window: from ${query.from} to ${query.to}`);
  }
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1)) {
    throw new ConsoleQueryError(`not a page size: ${query.limit}`);
  }
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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

/** A request and its start, parsed once. */
interface Placed {
  readonly head: TraceHead;
  readonly ms: number;
}

/**
 * The requests a query matches, `omit`'s filter left out, unordered. A request whose
 * `startedAt` does not parse is in no window.
 */
function placedMatching(heads: Iterable<TraceHead>, query: RequestQuery, omit?: FacetKey): Placed[] {
  const out: Placed[] = [];
  for (const head of heads) {
    const ms = Date.parse(head.startedAt);
    if (Number.isFinite(ms) && ms >= query.from && ms < query.to && matchesWhere(head, query.where, omit)) out.push({ head, ms });
  }
  return out;
}

/** Newest first; a tie on the instant is broken by id, so the order is total and pages never overlap. */
const newestFirst = (a: Placed, b: Placed): number => b.ms - a.ms || cmp(b.head.invocationId, a.head.invocationId);

/** The requests a query matches, every page of them, newest first. */
export function matching(heads: Iterable<TraceHead>, query: RequestQuery, omit?: FacetKey): TraceHead[] {
  return placedMatching(heads, query, omit).sort(newestFirst).map((p) => p.head);
}

/**
 * How many requests matching the query carry each value of `key`, its own filter left out.
 * `null` is not a value.
 */
export function countFacet(heads: Iterable<TraceHead>, query: RequestQuery, key: FacetKey): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { head } of placedMatching(heads, query, key)) {
    const v = facetValueOf(head, key);
    if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}

const CURSOR = /^c1:(-?\d+):(.+)$/;

function readCursor(cursor: string): { ms: number; id: string } {
  const m = CURSOR.exec(cursor);
  if (!m) throw new ConsoleQueryError(`not a cursor this source wrote: ${cursor}`);
  return { ms: Number(m[1]), id: m[2] as string };
}

/**
 * One page of a query. The cursor is a keyset (the last request's position, not an offset),
 * so a NEW request arriving mid-walk shifts nothing. A re-recorded one is different: requests
 * are deduplicated by `invocationId`, last record wins, so a re-record that moves `startedAt`
 * across the cursor during a walk can be skipped or seen twice. That is inherent to keyset
 * paging over a moving key; a reader that must not miss one re-reads it by id.
 */
export function pageOf(heads: Iterable<TraceHead>, query: RequestQuery): RequestPage {
  assertQuery(query);
  const limit = Math.min(query.limit ?? DEFAULT_PAGE, MAX_PAGE);
  const at = query.cursor === undefined ? undefined : readCursor(query.cursor);
  const rest = placedMatching(heads, query)
    .filter((p) => at === undefined || p.ms < at.ms || (p.ms === at.ms && p.head.invocationId < at.id))
    .sort(newestFirst);
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];
  return { requests: page.map((p) => p.head), nextCursor: rest.length > limit && last ? `c1:${last.ms}:${last.head.invocationId}` : null };
}

/** Exact facet counts of a query, each key counted with its own filter left out. */
export function facetsOf(heads: readonly TraceHead[], query: RequestQuery): RequestFacets {
  assertQuery(query);
  const facets = {} as Record<FacetKey, FacetValue[]>;
  for (const key of FACET_KEYS) {
    facets[key] = [...countFacet(heads, query, key)]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || cmp(a.value, b.value))
      .slice(0, FACET_TOP);
  }
  return { total: placedMatching(heads, query).length, facets, estimated: false };
}
