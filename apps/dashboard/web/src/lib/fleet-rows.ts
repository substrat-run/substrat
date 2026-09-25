import type { AppHealthRow, AppMetricsView, AppRow } from './api';

/**
 * The Apps table's rows (#1767): every app the team has, worst first, each with its
 * health verdict, the sentence behind it, and its traffic.
 *
 * The verdict is the fleet-health read's (#1238). An app that is not running yet, or
 * whose install failed, is judged by its install state instead: a sweep verdict on an
 * app with nothing deployed would read "silent" and send the reader looking for a
 * schedule problem that is really an install.
 */
export type FleetVerdict = 'install-failed' | 'failing' | 'stale' | 'silent' | 'unknown' | 'installing' | 'ok';

export const VERDICTS: Record<FleetVerdict, { label: string; status: 'danger' | 'warning' | 'neutral' | 'info' | 'success'; rank: number }> = {
  'install-failed': { label: 'Install failed', status: 'danger', rank: 0 },
  failing: { label: 'Failing', status: 'danger', rank: 1 },
  stale: { label: 'Stale', status: 'warning', rank: 2 },
  silent: { label: 'Silent', status: 'warning', rank: 3 },
  unknown: { label: 'Unknown', status: 'neutral', rank: 4 },
  installing: { label: 'Installing', status: 'info', rank: 5 },
  ok: { label: 'OK', status: 'success', rank: 6 },
};

export interface FleetRow {
  scopeId: string;
  name: string;
  vertical: string;
  verdict: FleetVerdict;
  why: string;
  /** Null when traffic could not be read at all — rendered "—", never "0". */
  requests: number | null;
  errors: number | null;
  p95: number | null;
}

export function fleetRows(input: { apps: AppRow[]; health: AppHealthRow[] | null; metrics: AppMetricsView | null }): FleetRow[] {
  const health = new Map((input.health ?? []).map((h) => [h.scopeId, h]));
  const traffic = input.metrics?.available ? new Map(input.metrics.rows.map((m) => [m.scopeId, m])) : null;
  const rows = input.apps.map((a): FleetRow => {
    const h = health.get(a.app_scope_id);
    const t = traffic?.get(a.app_scope_id);
    const [verdict, why]: [FleetVerdict, string] =
      a.status === 'failed'
        ? ['install-failed', 'Provisioning failed before the app could run.']
        : a.status === 'provisioning'
          ? ['installing', 'Installing — assigning a hostname.']
          : h
            ? [h.state, h.reason]
            : ['unknown', 'Health could not be read for this app.'];
    return {
      scopeId: a.app_scope_id,
      name: a.name,
      vertical: a.vertical_slug,
      verdict,
      why,
      requests: traffic ? (t?.requests ?? 0) : null,
      errors: traffic ? (t?.errors ?? 0) : null,
      p95: t?.p95 ?? null,
    };
  });
  // Worst first; within a verdict, the busier app first — it is the one more people feel.
  return rows.sort((x, y) => VERDICTS[x.verdict].rank - VERDICTS[y.verdict].rank || (y.requests ?? 0) - (x.requests ?? 0));
}

/** 412 → "412", 3344 → "3.3k", 1_100_000 → "1.1M". */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${+(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${+(n / 1_000_000).toFixed(1)}M`;
}

/** An error rate as the table prints it, or null when there were no requests to rate. */
export function errorRate(errors: number, requests: number): string | null {
  if (requests === 0) return null;
  const pct = (errors / requests) * 100;
  return `${pct === 0 ? '0' : pct < 0.1 ? '<0.1' : pct.toFixed(1)}%`;
}

/** 310 → "310 ms", 1240 → "1.2 s" (the design renders ≥ 1000 ms as seconds). */
export function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}
