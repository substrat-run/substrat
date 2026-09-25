import type { EventFacetResult } from './api';

/**
 * DEV_MOCK fixtures for the Logs › Events mode (#1767): one facet answer per grouping,
 * shaped like the plane's so the mode renders without a backend. Preview-only — nothing
 * outside `VITE_DEV_MOCK` reads this file.
 */
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const DIMENSIONS: Record<string, Array<[string | null, number, number]>> = {
  type: [
    ['ticket.replied', 3912, 2],
    ['ticket.created', 1284, 4],
    ['ticket.assigned', 1146, 9],
    ['email.sent', 1698, 3],
    ['invoice.sent', 612, 41],
    ['work_order.completed', 348, 17],
    ['csat.recorded', 212, 88],
    ['deal.closed', 96, 312],
  ],
  operation: [
    ['acme-desk/post-reply', 3912, 2],
    ['acme-desk/receive-email', 1284, 4],
    ['acme-desk/assign', 1146, 9],
    ['acme-billing/send-invoice', 612, 41],
    ['acme-field/complete-work-order', 348, 17],
    ['acme-crm/close-deal', 96, 312],
  ],
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

const FIELDS: Record<string, Array<[string | null, number, number]>> = {
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

export function mockEventFacets(q: { groupBy?: string; field?: string; type?: string }): EventFacetResult {
  const rows = q.field
    ? (FIELDS[q.field] ?? [[null, 1840, 4]])
    : (DIMENSIONS[q.groupBy ?? 'type'] ?? DIMENSIONS.type!);
  // Narrowed to one type, the preview scales every bucket down so the click visibly
  // answers a smaller question.
  const scale = q.type ? 0.18 : 1;
  const buckets = [...rows].sort((a, b) => b[1] - a[1]).map(([value, count, ago]) => ({ value, count: Math.max(1, Math.round(count * scale)), lastSeen: at(ago) }));
  const grouped = buckets.reduce((n, b) => n + b.count, 0);
  // Erasure only shows under a payload grouping, where it can hide a value.
  const erased = q.field ? 12 : 0;
  return { buckets, total: grouped + erased, erased, truncated: !q.field && (q.groupBy ?? 'type') === 'type' && !q.type };
}
