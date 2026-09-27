/**
 * The query string of one app's tenant-log read (#1525) — pure, so the rules of what
 * reaches the wire can be pinned without a DOM or a `fetch`.
 *
 * Every filter here is dropped when falsy, EXCEPT the invocation id, which is dropped only
 * when absent. An empty id is a caller bug, and the plane answers it with a `400`; a
 * truthiness check would fold it into "no filter" and answer it with the app's whole log.
 */
export function tenantLogsQuery(q: {
  level?: string;
  search?: string;
  /** One call's lines (#1525) — narrows within this app, never past it. */
  invocationId?: string;
  /** #1747: one pattern's lines — a `ctx.log` template, verbatim. */
  template?: string;
  hours?: number;
  limit?: number;
  /** `since`/`until` are the chart's time cursor — a window ending in the past, which
   *  `hours` cannot name. Sent instead of `hours`, never beside it. */
  since?: string;
  until?: string;
}): URLSearchParams {
  const p = new URLSearchParams();
  if (q.level) p.set('level', q.level);
  if (q.search) p.set('search', q.search);
  if (q.invocationId !== undefined) p.set('invocationId', q.invocationId);
  // Presence, not truthiness, like the invocation id: an EMPTY template is a caller bug
  // the plane answers with a 400, and dropping it would answer it with the whole log.
  if (q.template !== undefined) p.set('template', q.template);
  if (q.hours) p.set('hours', String(q.hours));
  if (q.limit) p.set('limit', String(q.limit));
  if (q.since) p.set('since', q.since);
  if (q.until) p.set('until', q.until);
  return p;
}
