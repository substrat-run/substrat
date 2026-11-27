/**
 * Every transaction site in `control-plane-do.ts`, and where it lands when the directory splits
 * (K-68, directory split; rfc/tenant-scale.md §7.2). Step 3a's inventory: steps 3b to 3f rewrite
 * these sites, and this is the list they work from.
 *
 * Kept honest by `test/directory-split-inventory.test.ts`, which reads `control-plane-do.ts` and
 * refuses any difference, per method, between this list and the file: a transaction, a
 * `writeAndAudit` call, or an `audited`/`auditedConnectLink` call added, moved or removed without a
 * row here is red. Change the row in the same PR as the site.
 *
 * `lands` (the object after the split, rfc §7.1):
 * - `registry` (G), `tenant` (D), `both` (by row: the RFC's words are in `note`), `lake` (L, K-70);
 * - `every`: schema maintenance, which each object runs over its own tables;
 * - `retired`: the whole-directory backup and restore, replaced per object by D-78.
 *
 * `crossing`:
 * - `none`: one object, one transaction, as today;
 * - `intent-first`: the change spans two objects, and commits its intent in the deciding object
 *   first (rfc §7.3; `@substrat-run/kernel`'s `directory-crossing`);
 * - `projection`: authoritative in one object, and copied to another after it commits.
 */
export type Lands = 'registry' | 'tenant' | 'both' | 'lake' | 'every' | 'retired';
export type Crossing = 'none' | 'intent-first' | 'projection';

export interface SiteRow {
  /** The `ControlPlaneDO` member the site is in. */
  method: string;
  /** How many sites that member holds. */
  sites: number;
  /** The rfc §7.2 group. */
  group: string;
  lands: Lands;
  crossing: Crossing;
  note?: string;
}

const row = (method: string, group: string, lands: Lands, crossing: Crossing = 'none', note?: string, sites = 1): SiteRow => ({
  method, sites, group, lands, crossing, ...(note ? { note } : {}),
});

const SCHEMA = 'Schema and maintenance';
const BACKUP = 'Backup and restore';
const DRIVERS = 'Store drivers';
const TENANT = 'A tenant’s state';
const ROLLUPS = 'Rollups and logs';
const REPORTS = 'Platform reports';
const HOSTNAMES = 'Hostnames';
const SCOPE_STORES = 'Vertical scope stores';
const ROUTING = 'Routing read model';
const MIRROR = 'Dual-write (step 3b)';

/**
 * `transactionSync` and `storage.transaction` sites: 51 in code (the rfc's 48, plus the routing read
 * model's two, #3395, and the dual-write's one, step 3b).
 */
export const DIRECTORY_TRANSACTION_SITES: readonly SiteRow[] = [
  row('alarm', SCHEMA, 'registry', 'none',
    'The #1764 backfill (rfc: `armVersionMigrationsBackfill`, which arms it). rfc §7.2 groups it with schema work run in every object; ' +
    'what it moves is `vertical_versions` → `vertical_version_migrations`, both placed in G, so it runs in the registry only.'),
  row('applyDirectorySchema', SCHEMA, 'every', 'none',
    'The switch records’ and the membership fences’ creation with their backfill from the admin log. A new object is built at today’s shape and has no history to backfill.', 2),
  row('rebuildAtomically', SCHEMA, 'every', 'none', 'Also the site of `ensureAdminLogTenantNullable` and `ensureSweepRunsIntentKind`, which the rfc counts separately.'),
  row('ensureDirectoryColumns', SCHEMA, 'every'),

  row('snapshotDirectory', BACKUP, 'retired', 'none', 'D-78: PITR and an incremental export per object.'),
  row('importDump', BACKUP, 'retired', 'none', 'D-78: a tenant restores into a fresh object under a new epoch.'),

  row('recordStoreDriverRevokeWalk', DRIVERS, 'registry'),
  row('storeDriverState', DRIVERS, 'registry'),
  row('storeDriverDeclarations', DRIVERS, 'registry'),
  row('storeDriverRolloutPending', DRIVERS, 'registry'),
  row('storeDriverRolloutWalked', DRIVERS, 'registry'),
  row('holdStoreDriver', DRIVERS, 'registry'),
  row('claimStoreDriverRebuild', DRIVERS, 'registry'),
  row('advanceStoreDriverRebuild', DRIVERS, 'registry'),

  row('transitionScopeOrRefusal', TENANT, 'tenant', 'none', 'Read-decide-write on the scope and its tenant’s status: both in D.'),
  row('defineRoleOrRefusal', TENANT, 'tenant'),
  row('assignTenantRole', TENANT, 'tenant'),
  row('deleteScopeDirectory', TENANT, 'tenant'),
  row('backfillScopeScriptCopy', TENANT, 'tenant'),
  row('claimExpiredScopeScriptCopies', TENANT, 'tenant', 'none', 'Stops being a fleet-wide claim: each tenant object claims its own (K-69).'),
  row('settleScopeScriptCopy', TENANT, 'tenant'),
  row('applyMembership', TENANT, 'tenant'),
  row('revokeAndFence', TENANT, 'tenant'),
  row('auditedConnectLink', TENANT, 'tenant', 'none', 'Callers: `AUDITED_CALLERS`.'),
  row('audited', TENANT, 'tenant', 'none', 'Findings. Callers: `AUDITED_CALLERS`.'),
  row('grantConnectionInDirectory', TENANT, 'tenant'),
  row('revokeConnectionGrantInDirectory', TENANT, 'tenant'),
  row('writeSwitchIntent', TENANT, 'tenant'),
  row('restoreSwitchRecord', TENANT, 'tenant'),
  row('putConnectorStateFenced', TENANT, 'tenant'),
  row('settleUnrecordedOutcome', TENANT, 'tenant'),

  row('recordScopeStorage', ROLLUPS, 'tenant', 'none', 'A window in D, shipped to L (K-70).'),
  row('recordRequestDay', ROLLUPS, 'lake'),
  row('pruneRequestDays', ROLLUPS, 'lake'),
  row('recordCostDay', ROLLUPS, 'lake', 'none', 'The cost rollup writes L directly.'),
  row('recordCostContainers', ROLLUPS, 'lake'),
  row('pruneCostDays', ROLLUPS, 'lake'),
  row('recordScopeObject', ROLLUPS, 'tenant', 'none', 'The object-id map: D, projected to X.'),
  row('recordMeterDay', ROLLUPS, 'tenant', 'none', 'A window in D, shipped to L; written on the tenant object’s first wake of a day (K-69).'),
  row('pruneMeterDays', ROLLUPS, 'tenant'),
  row('recordOpsFailure', ROLLUPS, 'both', 'none', 'L, with a recent window in D and platform-level rows in G.'),
  row('recordSweepRun', ROLLUPS, 'tenant', 'none', 'The cadence guard’s last row in D; history to L.'),

  row('recordStaleScopes', REPORTS, 'registry', 'none', 'Computed from the index and Analytics Engine (rfc §8.2).'),

  row('bindHostnameInDirectory', HOSTNAMES, 'both', 'intent-first', 'Claim and confirm in G, bind in D (rfc §7.3).'),
  row('auditedHostnameUpdate', HOSTNAMES, 'both', 'intent-first', 'A change of scope or surface re-claims in G under the new crossing; issuance state is D’s alone.'),

  row('verticalScopeStores', SCOPE_STORES, 'registry'),

  // #3395 (K-72): the routing read model. Its writer is one function every source calls, so after the
  // split each object that holds route source rows (the registry: verticals; a tenant object: hostnames,
  // scopes, its tenant) runs these over its own tables and its own ledger.
  row('installRouteReadModel', ROUTING, 'every', 'none', 'The read model’s outbox, ledger and capture triggers, created with the object.'),
  row('publishRouteReadModel', ROUTING, 'every', 'none', 'The backfill: marks every key the object can publish dirty.'),
  row('constructor', MIRROR, 'retired', 'projection',
    'The transaction `directory-mirror.ts` installs its triggers and reads each flush batch in. The mirror is the old ' +
    'directory’s copy to the split’s objects: it exists only while both are written (3b–3e), and 3f’s reverse copy replaces it.'),

  row('writeAndAudit', '`writeAndAudit`', 'both', 'none', 'Split by caller: `WRITE_AND_AUDIT_CALLERS`.'),
];

/**
 * The members that call `writeAndAudit`: the 46 rfc §7.2 splits (19 G, 21 D, 2 L, 4 crossing), and the four
 * step 2 added afterwards (#3403's outbox shipping, #3406's window prune), which each object runs over its own.
 */
export const WRITE_AND_AUDIT_CALLERS: readonly SiteRow[] = [
  ...['recordStoreDriverRelease', 'approveStoreDriverReleaseAndAudit', 'revokeStoreDriverReleaseAndAudit', 'beginStoreDriverRollout',
    'finishStoreDriverRollout', 'insertVertical', 'updateVertical', 'deleteVertical', 'insertVersion', 'setVerticalServing',
    'recordMigrationsExtracted', 'recordWireAuth', 'setAdmission', 'admitVersion', 'rejectVersion', 'promoteChannel',
    'registerIdentityPool', 'setIssueStatus'].map((m) => row(m, 'writeAndAudit → G', 'registry')),
  row('insertMarkupRowAndAudit', 'writeAndAudit → G', 'registry', 'none', 'The rfc counts it in G; a per-tenant markup row goes to D (§3.1), so a 3b caller routes by the row’s tenant.'),
  ...['setTenantName', 'putTenantStore', 'putBlobStore', 'writeTenantTuple', 'writeOrgTenantTuple', 'writeTenantSystemGrant',
    'setScopeExpiresAt', 'keepAlivePendingScopeCopy', 'moveScopeRow', 'markScopeStoresFenced', 'markScopeProvisioned', 'insertOrg',
    'grantEntitlement', 'revokeEntitlement', 'insertConnection', 'updateConnectionSecret', 'revokeConnection', 'linkIdentity',
    'unlinkIdentity', 'writeImpersonation', 'endImpersonation'].map((m) => row(m, 'writeAndAudit → D', 'tenant')),
  row('markAccessLogDrained', 'writeAndAudit → L', 'lake', 'none', 'Log housekeeping: the access log ships to L (K-70).'),
  ...['ackDirectoryOutbox', 'advanceDirectoryLakeBackfill', 'setDirectoryLakeCapture'].map((m) =>
    row(m, 'writeAndAudit → each object’s outbox (#3403)', 'both', 'none', 'K-70 shipping: every object ships its own outbox, so it runs in whichever holds it.')),
  row('pruneDirectoryLakeWindow', 'writeAndAudit → each object’s window (#3406)', 'both', 'none',
    'K-70: the prune to the window runs in each object over the data sets it holds, once the lake holds them.'),
  row('pruneAccessLog', 'writeAndAudit → L', 'lake', 'none', 'Log housekeeping.'),
  row('createTenant', 'writeAndAudit → crossing', 'both', 'intent-first',
    'Claim id and slug in G, create the tenant object with its record, owner seat and admin row, confirm in G. ' +
    'A provisioner creating a managed tenant (#412) is the seventh crossing, D → D, through its platform intent.'),
  row('setTenantStatus', 'writeAndAudit → crossing', 'both', 'projection', 'Authoritative in D; projected to G, X and the edge read model (D-77). Nothing decides from the copy.'),
  row('reapTenant', 'writeAndAudit → crossing', 'both', 'intent-first', 'Driven by the tenant object; hostnames released in G, then the slug; the id kept as a tombstone.'),
  row('deleteHostname', 'writeAndAudit → crossing', 'both', 'intent-first', 'Unbind in D, then release the claim in G.'),
];

/** The members that call `audited` (findings) and `auditedConnectLink` (connect links): all D. */
export const AUDITED_CALLERS: readonly SiteRow[] = [
  'insertConnectLink', 'revokeConnectLink', 'consumeConnectLink', 'restoreConnectLink',
  'pruneFindings', 'setFindingStatus', 'createFindingRule', 'revokeFindingRule',
].map((m) => row(m, 'audited / auditedConnectLink', 'tenant'));

/**
 * The rfc counts 53 transaction sites: a text search, which also matched five comments. These are
 * the five names it gives that hold no site of their own, so the 48 it names, with #3395's two, are the whole list.
 */
export const RFC_COUNTED_NOT_SITES: readonly { name: string; why: string }[] = [
  { name: 'addColumn', why: 'a comment above `rebuildAtomically` mentions `transactionSync`; `addColumn` itself runs one ALTER' },
  { name: 'ensureAdminLogTenantNullable', why: 'calls `rebuildAtomically`, the site' },
  { name: 'ensureSweepRunsIntentKind', why: 'calls `rebuildAtomically`, the site' },
  { name: 'importDump (sync)', why: '`importDump` holds one async `transaction`; the sync one counted is a comment inside it' },
  { name: 'swapConnectorState', why: 'one compare-and-set `UPDATE … WHERE`, atomic without a transaction; the count matched the comment on `putConnectorStateFenced`' },
];
