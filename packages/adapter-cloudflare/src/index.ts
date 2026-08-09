/**
 * `@substrat-run/adapter-cloudflare` — the Durable-Object scope host (D-14).
 *
 * Milestone 1: the shared contract-test suites run in workerd against real
 * Durable Objects. The adapter boundary is the scope-host contract (§5.7):
 * everything above it is the same kernel + contracts + modules the pure adapter
 * runs, unchanged.
 *
 *   - CloudflareScopeHost — the coordinator (Worker isolate) implementing ScopeHost
 *   - defineScopeDO       — one SQLite-backed Durable Object per scope
 *   - ControlPlaneDO      — the cross-DO directory slice (roles + tenant tuples)
 *   - definePlatformSweeperDO — the alarm-driven trigger for `runPlatformSweep`
 *   - defineScopeSweeperDO    — the CP-less vertical's own timer: roster + alarm
 *                               driving `drainDue`/`runDueSchedules` per scope (#461)
 */
export { CloudflareScopeHost } from './host.js';
export type { CloudflareScopeHostOptions, ConnectorDelegation } from './host.js';
export { defineScopeDO } from './scope-do.js';
export { ControlPlaneDO } from './control-plane-do.js';
export { OperationQueue } from './serialization.js';
export { doScopedSql } from './sql.js';
export { createDoTupleChecker } from './checker.js';
export { definePlatformSweeperDO, PLATFORM_SWEEPER_NAME } from './platform-sweeper-do.js';
export type { PlatformSweeperDoConfig, PlatformSweepOutcome } from './platform-sweeper-do.js';
export { defineScopeSweeperDO, SCOPE_SWEEPER_NAME } from './scope-sweeper-do.js';
export type {
  ScopeSweeperDo,
  ScopeSweeperDoConfig,
  ScopeSweepHost,
  ScopeSweepOutcome,
  ScopeSweepReport,
} from './scope-sweeper-do.js';
export {
  createD1TenantStores,
  d1TenantRelationalStore,
  tenantStoreDatabaseName,
} from './d1.js';
export type { D1TenantStores, D1TenantStoresOptions } from './d1.js';
export {
  blobStoreBucketName,
  createR2BlobStores,
  r2TenantBlobStore,
} from './r2.js';
export type { R2BlobStores, R2BlobStoresOptions } from './r2.js';
export { createRouteResolver } from './route-resolver.js';
export type { RouteResolver } from './route-resolver.js';
export type { ControlPlaneReader, DoCheckerDeps } from './checker.js';
