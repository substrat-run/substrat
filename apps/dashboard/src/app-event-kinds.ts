/**
 * Every kind a row of `dashboard_app_events` can hold — the ONE list behind the row's type
 * (`DashboardAppEventRow` in `module.ts`) and the declared route's output (`appEvent` in
 * `routes.ts`). The table's CHECK is the third copy: migrations are append-only, so it cannot
 * import this, and `test/apps-team-routes.test.ts` holds the latest one to it. A kind added
 * here without a migration widening the CHECK fails that test; the reverse fails it too.
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

export type AppEventKind = (typeof APP_EVENT_KINDS)[number];
