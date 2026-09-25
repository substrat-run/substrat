import type { EventFacetResult } from './api';

/**
 * DEV_MOCK fixtures for the Logs › Events mode (#1767): one facet answer per grouping,
 * shaped like the plane's so the mode renders without a backend. Preview-only — nothing
 * outside `VITE_DEV_MOCK` reads this file.
 *
 * The mock answers the SAME question the real read does: the type filter and the
 * `since`/`until` window both apply. A preview that ignored either would show a narrowed
 * type's bars over unrelated operations, or current events under a historical cursor —
 * the exact disagreement between controls and counts the mode exists to avoid.
 */

/** How far back the fixture's events reach. Each bucket's events are spread evenly from
 *  here to its last-seen instant, so a window sees the share of them it overlaps. */
const FIXTURE_SPAN_MINUTES = 7 * 24 * 60;

/** [value, count, minutes since last seen] */
type Row = [string | null, number, number];

const TYPES: Row[] = [
  ['ticket.replied', 3912, 2],
  ['ticket.created', 1284, 4],
  ['ticket.assigned', 1146, 9],
  ['email.sent', 1698, 3],
  ['invoice.sent', 612, 41],
  ['work_order.completed', 348, 17],
  ['csat.recorded', 212, 88],
  ['deal.closed', 96, 312],
];

/** [operation, the type it emits, count, minutes since last seen]. A consumer's emission
 *  has no operation, which is why two types land on the null one. */
const OPERATIONS: Array<[string | null, string, number, number]> = [
  ['acme-desk/post-reply', 'ticket.replied', 3912, 2],
  ['acme-desk/receive-email', 'ticket.created', 1284, 4],
  ['acme-desk/assign', 'ticket.assigned', 1146, 9],
  [null, 'email.sent', 1698, 3],
  ['acme-billing/send-invoice', 'invoice.sent', 612, 41],
  ['acme-field/complete-work-order', 'work_order.completed', 348, 17],
  [null, 'csat.recorded', 212, 88],
  ['acme-crm/close-deal', 'deal.closed', 96, 312],
];

const DIMENSIONS: Record<string, Row[]> = {
  actor: [
    ['user', 6120, 2],
    ['schedule', 3480, 5],
    ['connector', 1690, 3],
    ['service', 1212, 9],
  ],
  version: [
    ['2.15.0', 4210, 2],
    ['2.14.3', 3988, 190],
    ['2.14.2', 960, 2900],
  ],
  entityType: [
    ['ticket', 8994, 2],
    ['invoice', 612, 41],
    ['work-order', 348, 17],
    ['deal', 96, 312],
    [null, 44, 60],
  ],
  piiClass: [
    ['none', 5210, 2],
    ['personal', 6802, 3],
    ['sensitive', 36, 140],
  ],
};

const FIELDS: Record<string, Row[]> = {
  channel: [
    ['email', 5210, 2],
    ['web', 4120, 3],
    ['mobile', 980, 11],
    ['api', 610, 25],
  ],
  priority: [
    ['normal', 8120, 2],
    ['high', 1602, 6],
    ['urgent', 212, 30],
  ],
};

const TYPE_TOTAL = TYPES.reduce((n, [, c]) => n + c, 0);

/** The rows a grouping answers with, narrowed to one type where the fixture can say so. */
function rowsFor(q: { groupBy?: string; field?: string; type?: string }): Row[] {
  const groupBy = q.field ? 'field' : (q.groupBy ?? 'type');
  if (groupBy === 'type') return q.type ? TYPES.filter(([t]) => t === q.type) : TYPES;
  if (groupBy === 'operation') {
    // Grouped by operation, the type filter is exact: keep the operations that emit it,
    // and fold the ones sharing an operation (the null one) into a single bucket.
    const byOp = new Map<string | null, Row>();
    for (const [op, type, count, ago] of OPERATIONS) {
      if (q.type && type !== q.type) continue;
      const had = byOp.get(op);
      byOp.set(op, had ? [op, had[1] + count, Math.min(had[2], ago)] : [op, count, ago]);
    }
    return [...byOp.values()];
  }
  const rows = groupBy === 'field' ? (FIELDS[q.field!] ?? [[null, 1840, 4]]) : (DIMENSIONS[groupBy] ?? TYPES);
  if (!q.type) return rows;
  // Elsewhere the fixture has no per-type breakdown, so a narrowed type gets its share of
  // every bucket — and an unknown type none at all, as the real read would.
  const share = (TYPES.find(([t]) => t === q.type)?.[1] ?? 0) / TYPE_TOTAL;
  return rows.map(([v, c, ago]): Row => [v, Math.round(c * share), ago]).filter(([, c]) => c > 0);
}

export function mockEventFacets(
  q: { groupBy?: string; field?: string; type?: string; since?: string; until?: string },
  now: number = Date.now(),
): EventFacetResult {
  const start = now - FIXTURE_SPAN_MINUTES * 60_000;
  const since = q.since ? Math.max(Date.parse(q.since), start) : start;
  const until = q.until ? Math.min(Date.parse(q.until), now) : now;
  const buckets = rowsFor(q)
    .flatMap(([value, count, ago]) => {
      // This bucket's events run from the fixture's start to its last-seen instant; the
      // window counts the share it overlaps, and one it misses entirely is no bucket.
      const last = now - ago * 60_000;
      const to = Math.min(until, last);
      if (to < since) return [];
      const n = Math.round((count * (to - since)) / Math.max(1, last - start));
      return n > 0 ? [{ value, count: n, lastSeen: new Date(to).toISOString() }] : [];
    })
    .sort((a, b) => b.count - a.count);
  const grouped = buckets.reduce((n, b) => n + b.count, 0);
  // Erasure only shows under a payload grouping, where it can hide a value — and only
  // when something in the window was grouped at all.
  const erased = q.field && grouped > 0 ? Math.max(1, Math.round(grouped * 0.001)) : 0;
  return {
    buckets,
    total: grouped + erased,
    erased,
    truncated: !q.field && (q.groupBy ?? 'type') === 'type' && !q.type && buckets.length > 0,
  };
}
