export {
  createControlPlaneApi,
  tenantCredentialPin,
  CLI_MIN_VERSION_HEADER,
  CLI_LATEST_VERSION_HEADER,
} from './api.js';
export type { ControlPlaneApiOptions, ConnectionInspector } from './api.js';
export {
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  TENANT_HEADER,
  UNSAFE_devPlatformActorAuth,
  sessionPlatformAuth,
  staffAllowlist,
  serviceTokenAuth,
  firstPlatformActorAuth,
  firstBuilderAuth,
  confinedTenant,
} from './auth.js';
export { relayConnectionUpsert, ConnectionRelayError } from './connection-relay.js';
export { relayConnectUrl, ConnectUrlRelayError } from './connect-url.js';
export type { ConnectFlowSpec, ConnectUrlRelayOptions } from './connect-url.js';
export {
  reconcileConnectionGrants,
  type ConnectionGrantReconcileDeps,
  type ConnectionGrantReconcileReport,
} from './connection-grants.js';
export { mintPushToken, verifyPushToken, pushTokenBuilderAuth, pushActorFor } from './push-token.js';
export { mintTenantToken, verifyTenantToken, tenantTokenAuth } from './tenant-token.js';
export type {
  PlatformActorAuth,
  StaffIdentity,
  StaffSessionReader,
  StaffActorResolver,
  BuilderIdentity,
  BuilderAuth,
  TenantServiceIdentity,
  TenantServiceAuth,
  Principal,
} from './auth.js';
export { ControlPlaneClient, ControlPlaneError } from './client.js';
export type { ControlPlaneClientOptions, ClientProvisionScopeInput } from './client.js';
export { identityTenant, identityTenantsResponse } from './identity-tenants.js';
export type { IdentityTenant } from './identity-tenants.js';
export { VerticalClient } from './vertical-client.js';
export { versionReachedAt } from './scope-deployment.js';
// #1705 PR 2: the cross-vertical phase's reach for a control plane whose scopes live elsewhere.
export { hostedCrossVerticalReach } from './cross-vertical.js';
// A preview's own sign-in client (#1704): the create's wiring, and the reap's half the
// platform sweep also runs when it garbage-collects an expired preview.
export { retireAllPreviewClients, retireClientsOfReapedScope, tenantIssuers, wirePreviewAuth } from './preview-auth.js';
export type { PreviewAuthDeps, WirePreviewAuthInput } from './preview-auth.js';
export type { ScopeDeployment, ScopeDeploymentVia } from './scope-deployment.js';
export {
  drainScopePlatformRequests,
  MAX_PLATFORM_REQUEST_ATTEMPTS,
  provisionSiblingScope,
  provisionSiblingHandler,
  archiveScopeHandler,
  peerInvokeHandler,
  provisionTenantHandler,
  setEntitlementsHandler,
  modelUsageHandler,
  sweepRunsHandler,
  connectorDispatchHandler,
  type ConnectorDispatchDeps,
  type ManagedTenantDeps,
  type PlatformDrainOptions,
  type ArchiveScopeDeps,
  type PlatformRequestHandler,
  type PlatformRequestContext,
  type PlatformRequestOutcome,
  type PlatformDrainReport,
  type PeerInvokeDeps,
  type ProvisionSiblingDeps,
  type ProvisionSiblingInput,
  type ProvisionSiblingResult,
} from './platform-drain.js';
export { reconcilePayloadFor } from './reconcile.js';
export type { ReconcilePayload, ReconcileGatherAdmin } from './reconcile.js';
export { attributeFailure, terminalFailureNote } from './failure-attribution.js';
export type {
  VerticalClientOptions,
  ProvisionInstanceInput,
  ProvisionedInstance,
  ConfigureInstanceInput,
} from './vertical-client.js';
export {
  assertSandboxContract,
  deployManifest,
  deploymentRefFor,
  stableDeploymentRefFor,
  nextMigrationTag,
  DeployUploadError,
  upstreamStatusOf,
} from './deploy.js';
export type {
  DeployVerticalFn,
  FetchVerticalAssetFn,
  FetchVerticalModulesFn,
  RecoverAssetContentFn,
  VerticalBundle,
  DeclaredBinding,
  DeployManifest,
} from './deploy.js';
export { createWfpUploader, createWfpModulesFetcher, createWfpBindingsPatcher } from './wfp.js';
export type {
  WfpUploaderOptions,
  PatchScriptBindingsFn,
  ScriptBindingSpec,
  D1BindingSpec,
  R2BindingSpec,
} from './wfp.js';
export {
  blobStoreBindings,
  collectBlobStoreHandles,
  collectTenantStoreHandles,
  tenantStoreBindings,
} from './tenant-stores.js';
export {
  createCustomHostnameProvisioner,
  mapCfStatus,
  extractRecords,
  reconcilePendingHostnames,
  isCustomHostname,
  validateBindableHostname,
} from './custom-hostnames.js';
export type {
  CustomHostnameProvisioner,
  CustomHostnameProvisionerOptions,
  CustomHostnameIssuance,
  ReconcileHostnamesResult,
} from './custom-hostnames.js';
export type {
  ObservabilityReader,
  ServiceMetricsRow,
  RecentLogEvent,
  TenantMetricsBucket,
  ConnectorCallsBucket,
} from './observability.js';
export { TENANT_SERIES_SCOPE_CAP } from './observability.js';
export {
  STORAGE_PAGE_DEFAULT,
  STORAGE_PAGE_MAX,
  STORAGE_READ_CONCURRENCY,
  readStoragePage,
} from './storage-meter.js';
export type { StoragePageInput, StorageScope } from './storage-meter.js';
export type { PlatformRuntime } from './platform-runtime.js';
export { createCfDoNamespaceReader, namespacesForScript } from './do-namespaces.js';
export type { DoNamespaceReader, DoNamespaceRecord, CfDoNamespaceOptions } from './do-namespaces.js';
export { createCfObservabilityReader } from './cf-observability.js';
export type { CfObservabilityOptions } from './cf-observability.js';
export type {
  ScopeBackup,
  ScopeBackupStore,
  DirectoryBackup,
  DirectoryBackupStore,
} from './backups.js';
export {
  createR2AccessLogSink,
  createR2BackupStore,
  createR2DirectoryBackupStore,
  // The `EventSink` seam's NDJSON shape (#1334). Written and tested since the seam
  // landed and NOT exported until now, which is why nothing could bind it: the drain
  // phase has been complete on both adapters and unreachable from any deployment.
  createR2EventSink,
  pruneAccessLogBatches,
  pruneScopeBackups,
} from './r2-backups.js';
// The same seam's Pipelines shape — kernel-design §5.3's Cloudflare row for event
// transport. Which one a deployment binds is its choice; the drain never learns.
export { createPipelinesEventSink } from './pipelines-sink.js';
// #40 — the scheduled directory copy. Exported as a function the CP worker's cron calls,
// not as a route with a timer behind it: this package stays library-only, exactly as the
// platform-request drain does (the recurrence has to come from a deployment, #444).
export { backupDirectoryIfDue } from './directory-backup.js';
export type { DirectoryBackupOptions, DirectoryBackupResult } from './directory-backup.js';
// The masked-export generator (#1034). Exported because the property that matters most
// about it is one this package cannot assert on its own: that a pseudonymized dump still
// re-imports and still parses when a VERTICAL reads it back. That round trip needs the
// generator, an adapter and a vertical in one process, and the only place all three meet
// is a vertical's own suite — `demos/callout/test/masked-round-trip.test.ts`.
export { maskDump, maskRecords, MASKED } from './mask.js';
export { createPseudonymizer, kindOf, kindUnder } from './pseudonymize.js';
export type { PiiKind, Pseudonymizer } from './pseudonymize.js';

export { resolveObservabilityWindow, observabilityBucketMinutes } from './observability-window.js';
export type { ObservabilityWindow, ObservabilityWindowInput } from './observability-window.js';
