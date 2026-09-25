/**
 * One traffic row per app for the Apps table (#1767): requests, errors and p95 over a
 * window, for every app the team has installed.
 *
 * The p95 comes from the plane's `scope` grain, grouped at the source, because a p95
 * cannot be rebuilt from per-surface p95s. A control plane that predates the grain
 * ignores the parameter and answers by surface. The sums still fold correctly, so
 * requests and errors survive. The p95 does not: it reads `null` ("not measured")
 * rather than any per-surface number standing in for the app's. So a deploy order of
 * dashboard first, then control plane, degrades to a blank column, never a wrong one.
 *
 * The read is capped (`cap`, the plane's `TENANT_METRICS_LIMIT`), busiest first. An app
 * missing from a SHORT answer had no traffic and reads 0; an app missing from a FULL one
 * was never read — it may be busy — and reads `null`, never 0. Paging past the cap is the
 * follow-up if a team ever has that many apps with traffic.
 *
 * Environment-free (no worker imports), so the web client can parity-check its mirror.
 */
export interface AppMetricsRow {
  scopeId: string;
  /** Null when this app's traffic was not read — see `cap` on the view. */
  requests: number | null;
  errors: number | null;
  /** Milliseconds; null when the plane could not group by app (see above), or no traffic. */
  p95: number | null;
}

export interface AppMetricsView {
  /** False when no tenant-grain reader is configured — the column says so, not "0". */
  available: boolean;
  /**
   * Set when the read came back full: the answer stopped at this many rows, and a row
   * whose `requests` is null is an app beyond it — not in the top `cap` by traffic.
   */
  cap: number | null;
  rows: AppMetricsRow[];
}

export interface TenantMetricsInputRow {
  scopeId: string;
  surface: string | null;
  requests: number;
  errors: number;
  durationP95: number;
}

export function deriveAppMetrics(input: { rows: TenantMetricsInputRow[] | null; scopeIds: string[]; cap: number }): AppMetricsView {
  if (input.rows === null) return { available: false, cap: null, rows: input.scopeIds.map((scopeId) => ({ scopeId, requests: 0, errors: 0, p95: null })) };
  // One surface-named row anywhere means the plane answered by surface: the p95s are
  // per-surface and none of them is the app's.
  const grouped = input.rows.every((r) => r.surface === null);
  const full = input.rows.length >= input.cap;
  const by = new Map<string, AppMetricsRow & { seen: number }>();
  for (const scopeId of input.scopeIds) by.set(scopeId, { scopeId, requests: 0, errors: 0, p95: null, seen: 0 });
  for (const r of input.rows) {
    // A row for a scope this team does not list is dropped: the read is tenant-forced,
    // so it can only be an app removed since, and the table is about apps that exist.
    const row = by.get(r.scopeId);
    if (!row) continue;
    row.requests = (row.requests ?? 0) + r.requests;
    row.errors = (row.errors ?? 0) + r.errors;
    row.seen += 1;
    // Two grouped rows for one scope (a plane that also grouped by vertical, across a
    // rebind) are two p95s nobody can combine: not measured, rather than the last one.
    if (grouped && r.requests > 0) row.p95 = row.seen === 1 ? r.durationP95 : null;
  }
  return {
    available: true,
    cap: full ? input.cap : null,
    rows: [...by.values()].map(({ seen, ...row }) =>
      // Past a full answer: unseen is unread. And a full PER-SURFACE answer may have cut
      // a quiet surface off an app it did list, so no sum in it can be trusted as whole.
      full && (seen === 0 || !grouped) ? { ...row, requests: null, errors: null, p95: null } : row,
    ),
  };
}
