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
export type {
  CloudflareScopeHostOptions,
  ConnectorDelegation,
  EventDrainDelegation,
  PeerSwitchDelegation,
  ImportCursorDelegation,
  CapabilityDelegation,
  SystemSwitchDelegation,
  LifecycleDelegation,
  LifecycleDeliveryReport,
} from './host.js';
export { defineScopeDO } from './scope-do.js';
export { ControlPlaneDO } from './control-plane-do.js';
export type { DirectoryInventory } from './control-plane-do.js';
// K-68 (directory split), step 3a: the registry and the per-tenant directory object, empty of traffic.
export {
  DirectoryRegistryDO,
  TenantDirectoryDO,
  REGISTRY_OBJECT_NAME,
  durableDirectoryObjects,
  registryStub,
  tenantDirectoryNameOf,
  tenantDirectoryStub,
} from './directory-objects.js';
export { DIRECTORY_PLACEMENT, directoryObjectSchema, type DirectoryObjectKind, type Placement, type TablePlacement } from './directory-placement.js';
export { OperationQueue } from './serialization.js';
export { doScopedSql } from './sql.js';
export { createDoTupleChecker } from './checker.js';
export { definePlatformSweeperDO, PLATFORM_SWEEPER_NAME } from './platform-sweeper-do.js';
// #1705 PR 2: the global bound on the router's cross-vertical kick, one object per producer.
export {
  defineKickCoalescerDO,
  kickCoalescerName,
  CROSS_VERTICAL_KICK_WINDOW_MS,
  type KickCoalescerConfig,
  type KickCoalescerDo,
  type KickOutcome,
  type KickProducer,
} from './kick-coalescer-do.js';
// K-69, step 4.2 (#3376): one object per connection, whose alarm runs that connection's sweep.
export {
  defineConnectionSweepDO,
  connectionSweepName,
  spreadOf as connectionSweepSpreadOf,
  CONNECTION_SWEEP_INTERVAL_MS,
  CONNECTION_SWEEP_OVERDUE_MS,
  CONNECTION_SWEEP_FIRST_SPREAD_MS,
  type ConnectionSweepCheck,
  type ConnectionSweepConfig,
  type ConnectionSweepDo,
  type ConnectionSweepRef,
  type ConnectionSweepRun,
} from './connection-sweep-do.js';
export type { PlatformSweeperDoConfig, PlatformSweepOutcome } from './platform-sweeper-do.js';
// #2450 step 2: one object per background scope copy, stepped by alarm.
export { defineCopyJobDO, type CopyJobDo, type CopyJobDoConfig, type CopyJobDoRecord, type CopyJobStep } from './copy-job-do.js';
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
// #3395: the routing read model's one projection writer and its entry builders, for every source
// that will feed it (the directory today; the registry and per-tenant objects after K-68's split).
export {
  routeEntryKey,
  routeEntryOf,
  servingPolicyEntryKey,
  servingPolicyEntryOf,
  sqlPublishedLedger,
  writeRouteReadModelEntry,
  type PublishedLedger,
  type RouteKvWriter,
  type RouteReadModelKey,
  type RouteSourceFields,
} from './route-read-model-publisher.js';
export type { RouteResolver } from './route-resolver.js';
export type { ControlPlaneReader, DoCheckerDeps } from './checker.js';
export { cloudflareClientContext, cloudflareGeo } from './client-context.js';
export type { CloudflareRequestLike } from './client-context.js';
// #1978: moved here from the kernel — the hosted connector-call recorder.
export {
  analyticsEngineConnectorCallRecorder,
  CONNECTOR_CALL_DATA_POINT_LAYOUT,
  connectorCallDataPoint,
} from './connector-calls.js';
export type { AnalyticsEngineDatasetLike } from './connector-calls.js';
