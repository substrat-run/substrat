export { scopeHostContractSuite } from './scope-host-suite.js';
export type { ScopeHostFixture, ScopeHostSuiteOptions } from './scope-host-suite.js';
export { permissionContractSuite } from './permission-suite.js';
export { atomicContractSuite } from './atomic-suite.js';
export { impersonationContractSuite } from './impersonation-suite.js';
export { capabilityContractSuite } from './capability-suite.js';
export { becomeMintContractSuite, type BecomeMintVerbs } from './become-mint-suite.js';
export { capabilityAttachmentContractSuite } from './capability-attachment-suite.js';
export { attachmentTextContractSuite } from './attachment-text-suite.js';
export type { AttachmentTextHostFixture, AttachmentTextHostOptions } from './attachment-text-suite.js';
export { ATTACHMENT_TEXT_FIXTURES, DOCX_LINES, hostilePdfs } from './attachment-text-fixtures.js';
export type { AttachmentTextFixture, HostilePdf } from './attachment-text-fixtures.js';
export { capabilityExpiryContractSuite } from './capability-expiry-suite.js';
export type { CapabilityExpiryFixture } from './capability-expiry-suite.js';
export { searchContractSuite } from './search-suite.js';
export { entityVersionContractSuite } from './entity-version-suite.js';
export { timelineContractSuite } from './timeline-suite.js';
export { concurrencyContractSuite } from './concurrency-suite.js';
export { emittedReportContractSuite } from './emitted-suite.js';
export { moduleLogContractSuite } from './module-log-suite.js';
export { asyncLogContractSuite, type AsyncLogFixture } from './async-log-suite.js';
export { idempotencyContractSuite } from './idempotency-suite.js';
export { listContractSuite } from './list-suite.js';
export { migrationDigestContractSuite } from './migration-digest-suite.js';
export { entityStateContractSuite } from './entity-state-suite.js';
export { entityStateMigrationContractSuite, type RawScopeAccess } from './entity-state-migration-suite.js';
export { stateMod } from './entity-state-module.js';
export { trashMod, TRASH_MODULE_ID, TBOX_PURGE_DAYS } from './entity-trash-module.js';
export { entityTrashContractSuite } from './entity-trash-suite.js';
export { subjectErasureContractSuite, type RawScopeQuery } from './subject-erasure-suite.js';
export { erasureOtherMod, erasureSquatterMod } from './erasure-module.js';
export { scheduleContractSuite } from './schedule-suite.js';
// #2005: forks and previews cause no outbound effects — the in-scope doors.
export { inertScopeContractSuite } from './inert-scope-suite.js';
// connections.md §3.5.4: a vertical's mailed connect link — single-use, revocable, expiring.
export { connectLinkContractSuite } from './connect-link-suite.js';
export { causedByContractSuite, scopeCausedByContractSuite } from './caused-by-suite.js';
export { causedByMod } from './caused-by-module.js';
// #1184: the membership executor — accept, redelivery, rollback, and the authority bound.
export { membershipExecutorContractSuite } from './membership-executor-suite.js';
export { findingsContractSuite } from './findings-suite.js';
export { findingsAtomicContractSuite, type DirectoryExec } from './findings-atomic-suite.js';
export { INVITEFIX_A, membershipFixtureMod } from './membership-module.js';
export { scheduleEntitlementContractSuite } from './schedule-entitlement-suite.js';
export { jobRunContractSuite } from './job-run-suite.js';
export { systemSwitchContractSuite } from './system-switch-suite.js';
export {
  verticalEventsContractSuite,
  crmExportMod,
  crmExportModManifest,
  boardImportMod,
  boardImportModManifest,
  CRM_VERTICAL,
  BOARD_VERTICAL,
  type VerticalEventsFixture,
} from './vertical-events-suite.js';
export { peerContractSuite, verticalResolutionContractSuite } from './peer-suite.js';
export { adminRowFaultSql, switchRecordFaultSql } from './switch-audit-fault.js';
export type { AdminRowFault } from './switch-audit-fault.js';
export { inputParseContractSuite } from './input-parse-suite.js';
export { spineGuardContractSuite } from './spine-guard-suite.js';
export { scopeRepointContractSuite } from './scope-repoint-suite.js';
export { sqlLimitsContractSuite } from './sql-limits-suite.js';
export { grantExpiryContractSuite } from './grant-expiry-suite.js';
export { facetRecencyContractSuite, type FacetRecencyFixture } from './facet-recency-suite.js';
export type { GrantExpiryFixture } from './grant-expiry-suite.js';
export { entityCheckConformanceSuite, planEntityCheckCoverage } from './entity-check-suite.js';
export type { EntityCheckFixture, EntityCheckSuiteOptions, PlannedCheck } from './entity-check-suite.js';
export { nodeOnlySuite, declaredNodeOnlySuite } from './node-only-suite.js';
export type { NodeOnlyOptions } from './node-only-suite.js';
export { declareEntityChecks, declareNodeOnly, assertNodeOnly } from './conformance.js';
export type {
  ConformanceDeclaration,
  DrivenConformance,
  DeclaredNodeOnlyConformance,
  AssertedNodeOnlyConformance,
} from './conformance.js';
export {
  atomicMod,
  billedMod,
  brokenMod,
  connectorMod,
  contractTestBareOps,
  contractTestInitialModules,
  contractTestModules,
  liveMod,
  liveModManifest,
  permMod,
  capMod,
  capModManifest,
  peerMod,
  peerModManifest,
  PEER_CALLER,
  PEER_LISTENER,
  scheduleMod,
  composedEngineMod,
  composerMod,
  jobsMod,
  testMod,
  freshnessMod,
  searchMod,
  searchModManifest,
  listDeclaredOps,
  listMod,
  listModManifest,
  parseMod,
  parseModManifest,
  spineParentMod,
  journalFenceDropMod,
  journalWriteMod,
  spineDropMod,
  spineShadowMod,
  ownParentMod,
  PRE_GUARD_REFUSALS_DDL,
} from './modules.js';
export {
  connectorCalls,
  connectorTestFetch,
  resetConnectorCalls,
  type ConnectorCall,
} from './connector-fixture.js';
export { directoryRestoreSuite, type DirectoryRestoreHarness, type RestorableDirectory } from './directory-restore-suite.js';
export { SPLIT_CASES } from './split-cases.js';
export { migrationCommentsContractSuite } from './migration-comments-suite.js';
export { commentedDdlMod } from './migration-comments.js';
export { shapeReconcilePlans } from './shape-reconcile-plan.js';
