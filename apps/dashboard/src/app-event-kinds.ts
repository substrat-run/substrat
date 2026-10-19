/**
 * Every kind a row of `dashboard_app_events` can hold — the ONE list behind `appEvent` in
 * `rows.ts`, which is both the declared route's output and the module's row
 * (`DashboardAppEventRow`, #2426). The table's CHECK is the second copy: migrations are
 * append-only, so it cannot import this, and `test/apps-team-routes.test.ts` holds the latest
 * one to it. A kind added here without a migration widening the CHECK fails that test; the
 * reverse fails it too.
 */
export const APP_EVENT_KINDS = [
  'created',
  'active',
  'failed',
  'deleted',
  'updated',
  'snapshotted',
  'snapshot-deleted',
  'data-exported',
  'data-restored',
  'hostname-bound',
  'hostname-unbound',
  'resumed',
] as const;
