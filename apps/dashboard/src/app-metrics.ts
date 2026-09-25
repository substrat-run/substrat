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
 * Environment-free (no worker imports), so the web client can parity-check its mirror.
 */
export interface AppMetricsRow {
  scopeId: string;
  requests: number;
  errors: number;
  /** Milliseconds; null when the plane could not group by app (see above), or no traffic. */
  p95: number | null;
}

export interface AppMetricsView {
  /** False when no tenant-grain reader is configured — the column says so, not "0". */
  available: boolean;
  rows: AppMetricsRow[];
}

export interface TenantMetricsInputRow {
  scopeId: string;
  surface: string | null;
  requests: number;
  errors: number;
  durationP95: number;
}

export function deriveAppMetrics(input: { rows: TenantMetricsInputRow[] | null; scopeIds: string[] }): AppMetricsView {
  if (input.rows === null) return { available: false, rows: input.scopeIds.map((scopeId) => ({ scopeId, requests: 0, errors: 0, p95: null })) };
  // One surface-named row anywhere means the plane answered by surface: the p95s are
  // per-surface and none of them is the app's.
  const grouped = input.rows.every((r) => r.surface === null);
  const by = new Map<string, AppMetricsRow>();
  for (const scopeId of input.scopeIds) by.set(scopeId, { scopeId, requests: 0, errors: 0, p95: null });
  for (const r of input.rows) {
    // A row for a scope this team does not list is dropped: the read is tenant-forced,
    // so it can only be an app removed since, and the table is about apps that exist.
    const row = by.get(r.scopeId);
    if (!row) continue;
    row.requests += r.requests;
    row.errors += r.errors;
    if (grouped && r.requests > 0) row.p95 = r.durationP95;
  }
  return { available: true, rows: [...by.values()] };
}
