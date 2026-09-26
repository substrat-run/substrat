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

/**
 * Each type's PII class (#1762) — the kernel's classes, per event type, so the PII-class
 * dimension and the payload groupings are answers about the same events. A reply carries
 * its body and a new ticket its sender, so narrowing to either is a population with no
 * `none` event in it: the one honest way to reach the "every event withheld" state.
 */
const TYPE_PII: Record<string, 'none' | 'pseudonymous' | 'direct'> = {
  'ticket.replied': 'direct',
  'ticket.created': 'direct',
  'ticket.assigned': 'none',
  'email.sent': 'pseudonymous',
  'invoice.sent': 'pseudonymous',
  'work_order.completed': 'none',
  'csat.recorded': 'pseudonymous',
  'deal.closed': 'none',
};

/** The share of a personal-data type's events whose payload was erased. */
const ERASED_SHARE = 0.001;

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
  // Derived from the types rather than stated, so it cannot disagree with a payload grouping.
  piiClass: (['none', 'pseudonymous', 'direct'] as const).map((cls): Row => {
    const of = TYPES.filter(([t]) => TYPE_PII[t!] === cls);
    return [cls, of.reduce((n, [, c]) => n + c, 0), Math.min(...of.map(([, , ago]) => ago))];
  }),
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

/** Elsewhere the fixture has no per-type breakdown, so a narrowed type gets its share of
 *  every bucket — and an unknown type none at all, as the real read would. */
function typeShare(type: string | undefined): number {
  if (!type) return 1;
  return (TYPES.find(([t]) => t === type)?.[1] ?? 0) / TYPE_TOTAL;
}

/** The rows a grouping answers with, narrowed to one type where the fixture can say so. */
function rowsFor(q: { groupBy?: string; type?: string }): Row[] {
  const groupBy = q.groupBy ?? 'type';
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
  const rows = DIMENSIONS[groupBy] ?? TYPES;
  if (!q.type) return rows;
  const share = typeShare(q.type);
  return rows.map(([v, c, ago]): Row => [v, Math.round(c * share), ago]).filter(([, c]) => c > 0);
}

export function mockEventFacets(
  q: { groupBy?: string; field?: string; type?: string; since?: string; until?: string },
  now: number = Date.now(),
): EventFacetResult {
  const start = now - FIXTURE_SPAN_MINUTES * 60_000;
  const since = q.since ? Math.max(Date.parse(q.since), start) : start;
  const until = q.until ? Math.min(Date.parse(q.until), now) : now;
  // This bucket's events run from the fixture's start to its last-seen instant; the
  // window counts the share it overlaps, and one it misses entirely is no bucket.
  const inWindow = (count: number, ago: number): { n: number; to: number } => {
    const last = now - ago * 60_000;
    const to = Math.min(until, last);
    return { n: to < since ? 0 : Math.round((count * (to - since)) / Math.max(1, last - start)), to };
  };
  if (q.field) return payloadFacet(q.field, q.type, inWindow);
  const buckets = rowsFor(q)
    .flatMap(([value, count, ago]) => {
      const { n, to } = inWindow(count, ago);
      return n > 0 ? [{ value, count: n, lastSeen: new Date(to).toISOString() }] : [];
    })
    .sort((a, b) => b.count - a.count);
  return {
    buckets,
    total: buckets.reduce((n, b) => n + b.count, 0),
    erased: 0,
    withheldPersonal: 0,
    truncated: (q.groupBy ?? 'type') === 'type' && !q.type && buckets.length > 0,
  };
}

/**
 * A payload grouping, the way the kernel counts it (#1762): the population is every event
 * matching the type filter and window, whatever field is named. Events classed `none` are
 * grouped — by the field's value where the fixture gives them one, and in the null bucket
 * where they do not carry it — and every other event is erased or withheld, whether or not
 * it carries the field. So `email` is not special: the `none` events lack it and land in
 * the null bucket, and the ones that carry it were never eligible.
 */
function payloadFacet(
  field: string,
  type: string | undefined,
  inWindow: (count: number, ago: number) => { n: number; to: number },
): EventFacetResult {
  const values = FIELDS[field];
  const valueTotal = values ? values.reduce((n, [, c]) => n + c, 0) : 0;
  const byValue = new Map<string | null, { count: number; to: number }>();
  let erased = 0;
  let withheldPersonal = 0;
  for (const [t, count, ago] of TYPES) {
    if (type && t !== type) continue;
    const { n, to } = inWindow(count, ago);
    if (n === 0) continue;
    if (TYPE_PII[t!] !== 'none') {
      const e = Math.round(n * ERASED_SHARE);
      erased += e;
      withheldPersonal += n - e;
      continue;
    }
    // The field's values split this type's events in the fixture's proportions; the
    // rounding remainder has no value, which is what the null bucket is.
    let left = n;
    for (const [v, c] of values ?? []) {
      const k = Math.floor((n * c) / valueTotal);
      left -= k;
      add(byValue, v, k, to);
    }
    add(byValue, null, left, to);
  }
  const buckets = [...byValue]
    .filter(([, b]) => b.count > 0)
    .map(([value, b]) => ({ value, count: b.count, lastSeen: new Date(b.to).toISOString() }))
    .sort((a, b) => b.count - a.count);
  return {
    buckets,
    total: buckets.reduce((n, b) => n + b.count, 0) + erased + withheldPersonal,
    erased,
    withheldPersonal,
    truncated: false,
  };
}

function add(m: Map<string | null, { count: number; to: number }>, value: string | null, count: number, to: number) {
  const had = m.get(value);
  m.set(value, had ? { count: had.count + count, to: Math.max(had.to, to) } : { count, to });
}
