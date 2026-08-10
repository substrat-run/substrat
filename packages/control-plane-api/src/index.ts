export { createControlPlaneApi } from './api.js';
export type { ControlPlaneApiOptions } from './api.js';
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
} from './auth.js';
export { relayConnectionUpsert, ConnectionRelayError } from './connection-relay.js';
export { mintPushToken, verifyPushToken, pushTokenBuilderAuth, pushActorFor } from './push-token.js';
export type {
  PlatformActorAuth,
  StaffIdentity,
  StaffSessionReader,
  StaffActorResolver,
  BuilderIdentity,
  BuilderAuth,
  Principal,
} from './auth.js';
export { ControlPlaneClient, ControlPlaneError } from './client.js';
export type { ControlPlaneClientOptions, ClientProvisionScopeInput } from './client.js';
export { VerticalClient } from './vertical-client.js';
export {
  drainScopePlatformRequests,
  MAX_PLATFORM_REQUEST_ATTEMPTS,
  provisionSiblingScope,
  provisionSiblingHandler,
  archiveScopeHandler,
  provisionTenantHandler,
  setEntitlementsHandler,
  connectorDispatchHandler,
  type ConnectorDispatchDeps,
  type ManagedTenantDeps,
  type PlatformDrainOptions,
  type ArchiveScopeDeps,
  type PlatformRequestHandler,
  type PlatformRequestContext,
  type PlatformRequestOutcome,
  type PlatformDrainReport,
  type ProvisionSiblingDeps,
  type ProvisionSiblingInput,
  type ProvisionSiblingResult,
} from './platform-drain.js';
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
export type { DeployVerticalFn, FetchVerticalAssetFn, VerticalBundle, DeclaredBinding, DeployManifest } from './deploy.js';
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
export type { ObservabilityReader, ServiceMetricsRow, RecentLogEvent } from './observability.js';
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
  pruneAccessLogBatches,
  pruneScopeBackups,
} from './r2-backups.js';
// #40 — the scheduled directory copy. Exported as a function the CP worker's cron calls,
// not as a route with a timer behind it: this package stays library-only, exactly as the
// platform-request drain does (the recurrence has to come from a deployment, #444).
export { backupDirectoryIfDue } from './directory-backup.js';
export type { DirectoryBackupOptions, DirectoryBackupResult } from './directory-backup.js';
