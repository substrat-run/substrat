/**
 * Where each of the directory's tables goes when the directory splits (K-68, directory split;
 * rfc/tenant-scale.md §3 and §7.1), and the DDL the two new objects run.
 *
 * Step 3a only: the registry and the tenant directory object are created EMPTY, with these tables,
 * and nothing writes them yet. Dual-write (3b), backfill (3c), verify (3d) and the cut-overs (3e,
 * 3f) come after step 2.
 *
 * The DDL is not a copy. Each object runs the directory's own statements (`DIRECTORY_DDL_PLAN`),
 * filtered to the tables placed in it, then the columns and indexes `ensureDirectoryColumns` adds to
 * a directory after its first shape. So a table in a new object has the column set the directory's
 * table has, and 3b and 3c copy a row by column name with nothing to translate. The column and index
 * half IS a copy (it lives in a method of `ControlPlaneDO`), and `test/directory-objects.test.ts`
 * holds it to a freshly built directory, table by table: a column added to the directory and not
 * here is red there.
 *
 * `to`:
 * - `registry`: the one global object (rfc §7.1: what must be unique or the same for every tenant).
 * - `tenant`: each tenant's directory object.
 * - `both`: the table exists in each. Which rows go where is the RFC row quoted beside it.
 * - `lake`: in neither object. Shipped to the lake by step 2 and read there (K-70).
 *
 * `ambiguous` names a placement the RFC leaves open or does not cover, and what this PR assumed.
 * The PR lists every one of them for the owner.
 */
import { DIRECTORY_CLAIMS_DDL, DIRECTORY_CROSSINGS_DDL, executableSqlStatements } from '@substrat-run/kernel';
import { DIRECTORY_DDL_PLAN } from './control-plane-do.js';

export type DirectoryObjectKind = 'registry' | 'tenant';
export type Placement = DirectoryObjectKind | 'both' | 'lake';

export interface TablePlacement {
  to: Placement;
  /** The RFC's "goes to" for the table, in its words. */
  rfc: string;
  ambiguous?: string;
}

export const DIRECTORY_PLACEMENT: Readonly<Record<string, TablePlacement>> = {
  // ── rfc §3.1, the tables written in DIRECTORY_DDL ──────────────────────────────────────────
  tenants: {
    to: 'both',
    rfc: 'G for id and slug uniqueness; D authoritative for name and status; X projection',
    ambiguous:
      'The uniqueness of id and slug is a claim in the registry (`_substrat_directory_claims`), not this table. ' +
      'The registry also keeps a `tenants` row as the projection §7.3 sends a status to ("projects to the registry ' +
      'and the index for lists"); K-68 leaves open whether the registry keeps it. Assumed: it does, and decides nothing from it.',
  },
  scopes: { to: 'tenant', rfc: 'D; the routing columns to KV' },
  scope_script_copies: { to: 'tenant', rfc: 'D, claimed by the tenant object’s alarm' },
  hostnames: {
    to: 'tenant',
    rfc: 'G owns uniqueness; D owns the binding; KV serves it',
    ambiguous:
      'Uniqueness is the registry’s `hostname` claim (hostname → tenant, scope); the binding row (surface, region, ' +
      'issuance state) is the tenant’s. §5.5 counts ≈150 K hostname rows in the registry: read as the claim rows.',
  },
  tenant_stores: { to: 'tenant', rfc: 'D' },
  blob_stores: { to: 'tenant', rfc: 'D' },
  verticals: { to: 'registry', rfc: 'G; per-version policy to KV keyed by version id' },
  vertical_versions: { to: 'registry', rfc: 'G, manifests to R2 by digest; per-version policy to KV' },
  vertical_channels: { to: 'registry', rfc: 'G' },
  vertical_channel_history: { to: 'registry', rfc: 'G' },
  orgs: { to: 'tenant', rfc: 'D' },
  _substrat_tenant_tuples: { to: 'tenant', rfc: 'D' },
  _substrat_roles: { to: 'tenant', rfc: 'D' },
  _substrat_entitlements: { to: 'tenant', rfc: 'D, projected to scopes as today' },
  _substrat_identity_pools: { to: 'registry', rfc: 'G' },
  _substrat_connections: { to: 'tenant', rfc: 'D' },
  _substrat_connection_secrets: { to: 'tenant', rfc: 'D, sealed as today' },
  _substrat_connection_keys: { to: 'tenant', rfc: 'D' },
  _substrat_connection_grants: { to: 'tenant', rfc: 'D' },
  _substrat_connector_state: { to: 'tenant', rfc: 'D' },
  _substrat_identities: { to: 'tenant', rfc: 'D; the cross-tenant "which tenants does this person belong to" read to X' },
  _substrat_access_log: { to: 'both', rfc: 'written in the object read (D or G), shipped to L' },
  _substrat_subject_keys: { to: 'tenant', rfc: 'D (never beside the scope’s own data)' },
  _substrat_admin_log: { to: 'both', rfc: 'written in the object that changes (D or G), shipped to L; recent window kept in the object' },
  _substrat_ops_failures: { to: 'both', rfc: 'L (+ recent window in D, platform-level rows in G)' },
  _substrat_issues: { to: 'registry', rfc: 'G (platform operations), fed from L' },
  _substrat_sweep_runs: {
    to: 'tenant',
    rfc: 'the cadence guard’s last row in D; history to L',
    ambiguous:
      'Units that are not a tenant’s (a store driver walk, the directory’s own backfill) record sweep outcomes today. ' +
      'The RFC places the table in D only; such rows have no object until it says where.',
  },
  _substrat_model_usage: { to: 'tenant', rfc: 'D window + L' },
  _substrat_build_usage: { to: 'tenant', rfc: 'D window + L' },
  _substrat_markup_schedule: { to: 'both', rfc: 'G for defaults; per-tenant rows in D' },
  scope_lifecycle_receipts: { to: 'tenant', rfc: 'D' },
  scope_tenant_asks: { to: 'tenant', rfc: 'D' },
  scope_lifecycle_failures: { to: 'tenant', rfc: 'D' },
  lifecycle_revisions: {
    to: 'tenant',
    rfc: 'D (scope and tenant counters live with what they count)',
    ambiguous:
      'The table also holds `directory:epoch`, the history the whole directory is in (minted by every restore). ' +
      'Assumed: each tenant object keeps its own epoch, minted when it is restored, and a deployment orders a ' +
      'scope’s deliveries by its tenant object’s epoch. The RFC does not say.',
  },

  // ── rfc §3.2, the tables in kernel-owned fragments ─────────────────────────────────────────
  peer_bindings: {
    to: 'tenant',
    rfc: 'D (a cross-tenant one is a dependency, K-64, and lives in both)',
    ambiguous: '"Both" read as both tenants’ objects, never the registry.',
  },
  store_driver_releases: { to: 'registry', rfc: 'G' },
  store_driver_approvals: { to: 'registry', rfc: 'G' },
  store_driver_revoke_walks: { to: 'registry', rfc: 'G' },
  store_driver_current: { to: 'registry', rfc: 'G' },
  store_driver_holds: { to: 'registry', rfc: 'G' },
  store_driver_rebuilds: { to: 'registry', rfc: 'G' },
  store_driver_rollouts: { to: 'registry', rfc: 'G' },
  store_driver_rollout_walks: { to: 'registry', rfc: 'G' },
  vertical_version_migrations: { to: 'registry', rfc: 'G, or R2 by version id' },
  vertical_scope_stores: { to: 'registry', rfc: 'G' },
  vertical_scope_store_versions: { to: 'registry', rfc: 'G' },
  vertical_scope_store_indexed: { to: 'registry', rfc: 'G' },
  vertical_wire_auth: { to: 'registry', rfc: 'G' },
  _substrat_connect_links: { to: 'tenant', rfc: 'D' },
  _substrat_impersonations: { to: 'tenant', rfc: 'D' },
  _substrat_system_switches: { to: 'tenant', rfc: 'D' },
  _substrat_peer_switches: { to: 'tenant', rfc: 'D' },
  _substrat_switch_owed: { to: 'tenant', rfc: 'D' },
  _substrat_membership_fences: { to: 'tenant', rfc: 'D' },
  _substrat_findings: { to: 'tenant', rfc: 'D' },
  _substrat_finding_rules: { to: 'tenant', rfc: 'D' },
  _substrat_scope_storage: { to: 'tenant', rfc: 'D window + L' },
  _substrat_scope_storage_attempts: { to: 'tenant', rfc: 'D window + L' },
  _substrat_scope_attachment_storage: { to: 'tenant', rfc: 'D window + L' },
  _substrat_scope_store_storage: { to: 'tenant', rfc: 'D window + L' },
  _substrat_request_days: {
    to: 'lake',
    rfc: 'L (+ the meter’s window in D)',
    ambiguous: '"the meter’s window in D" read as `_substrat_meter_days`’s window; request days themselves go to the lake only (§7.4: "written to the lake").',
  },
  _substrat_request_day_reads: {
    to: 'registry',
    rfc: '(not named; the request rollup’s per-day read cursor)',
    ambiguous: 'The central daily read stays central (§7.4), and its per-day cursor goes with it: assumed the registry.',
  },
  _substrat_cost_days: { to: 'lake', rfc: 'L' },
  _substrat_cost_day_reads: {
    to: 'registry',
    rfc: '(not named; the cost rollup’s per-day read cursor)',
    ambiguous: 'As `_substrat_request_day_reads`: the central read’s cursor, assumed the registry.',
  },
  _substrat_scope_objects: { to: 'tenant', rfc: 'the object-id map in D and X' },
  _substrat_scope_object_reads: {
    to: 'tenant',
    rfc: '(not named; per-scope failures of the object-id map’s read)',
    ambiguous: 'Keyed by scope, so assumed beside the map it fails to fill, in D.',
  },
  _substrat_meter_days: { to: 'tenant', rfc: 'D window + L' },
  _substrat_meter_day_takes: {
    to: 'registry',
    rfc: '(not named; the central meter snapshot’s per-day progress)',
    ambiguous:
      'Today one central pass snapshots every tenant per day. Under K-69 the tenant object writes its own on its ' +
      'first wake of a day and this table has nothing left to record. Assumed the registry until then.',
  },
  _substrat_stale_scopes: {
    to: 'registry',
    rfc: '§7.2 "Platform reports": G (platform operations)',
    ambiguous: 'Added by #3393 after §3 was written, so it has no §3 row; placed by §7.2.',
  },
  _substrat_stale_scope_takes: {
    to: 'registry',
    rfc: '§7.2 "Platform reports": G (platform operations)',
    ambiguous: 'Added by #3393 after §3 was written; placed by §7.2.',
  },
  _substrat_vertical_owners: { to: 'registry', rfc: 'G' },
};

const placedIn = (object: DirectoryObjectKind) => (table: string): boolean => {
  const placement = DIRECTORY_PLACEMENT[table];
  if (!placement) throw new Error(`directory table ${table} has no placement: add it to DIRECTORY_PLACEMENT (K-68)`);
  return placement.to === object || placement.to === 'both';
};

/** The table a directory DDL statement builds: a `CREATE TABLE`'s name, or the table an index is on. */
export function tableOfStatement(stmt: string): string {
  const table = /^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(stmt);
  if (table) return table[1]!;
  const index = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+\S+\s+ON\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(stmt);
  if (index) return index[1]!;
  throw new Error(`a directory DDL statement this placement cannot read: ${stmt.slice(0, 120)}`);
}

/**
 * The columns `ensureDirectoryColumns` (`control-plane-do.ts`) ALTERs into a directory after its
 * first shape, in its order, plus the two `buildDirectorySchema` adds after #1764's statements.
 * A copy, held to a built directory by `test/directory-objects.test.ts`, which compares each table's
 * stored `CREATE` text (so column order too) and its indexes. Some entries are already in their
 * table's `CREATE` and are a tolerated duplicate on a fresh object, as they are on a fresh directory;
 * they are kept so the list reads line for line against `ensureDirectoryColumns`.
 */
const SCOPE_COLUMNS = [
  'parent_scope_id TEXT', 'slug TEXT', 'kind TEXT', 'name TEXT', 'vertical TEXT', 'vertical_version_id TEXT',
  'erasure_epoch INTEGER', 'reap_claimed_at TEXT', 'stores_fenced_at TEXT', 'provisioned_version_id TEXT',
  'retirements_finished_version_id TEXT', 'bound_shapes TEXT', 'migration_failed_version TEXT', 'migration_error TEXT',
  'migration_attempts INTEGER NOT NULL DEFAULT 0', 'migration_last_attempt_at TEXT', 'forked_from TEXT', 'forked_at TEXT',
  'expires_at TEXT', 'serving_ref TEXT', 'archived_at TEXT', 'archived_from_status TEXT',
];
export const DIRECTORY_COLUMNS_ADDED: readonly (readonly [table: string, column: string])[] = [
  ...SCOPE_COLUMNS.map((c) => ['scopes', c] as const),
  ['tenants', 'deleting_at TEXT'],
  ['scope_lifecycle_receipts', 'tenant_recorded INTEGER'],
  ['tenants', 'provisioned_by_tenant TEXT REFERENCES tenants(tenant_id)'],
  ['hostnames', 'custom_hostname_id TEXT'],
  ['hostnames', 'validation_records TEXT'],
  ['_substrat_tenant_tuples', 'revoked_at TEXT'],
  ['_substrat_admin_log', 'caused_by TEXT'],
  ['_substrat_admin_log', 'on_behalf_of TEXT'],
  ['_substrat_access_log', 'on_behalf_of TEXT'],
  ['_substrat_ops_failures', 'version TEXT'],
  ['_substrat_ops_failures', 'origin TEXT'],
  ['_substrat_ops_failures', 'code TEXT'],
  ['_substrat_ops_failures', 'fingerprint TEXT'],
  ['_substrat_issues', 'last_version TEXT'],
  ['_substrat_issues', 'resolved_version TEXT'],
  ['_substrat_issues', 'last_tenant_id TEXT'],
  ['_substrat_issues', 'last_owner_kind TEXT'],
  ['_substrat_sweep_runs', 'request_id TEXT'],
  ['_substrat_sweep_runs', 'event_type TEXT'],
  ['_substrat_sweep_runs', 'observed_at TEXT'],
  ['_substrat_sweep_runs', 'platform_requests TEXT'],
  ['_substrat_connections', 'owner_scope_id TEXT'],
  ['verticals', 'owner_tenant TEXT'],
  ['verticals', 'env_spec TEXT'],
  ['verticals', 'install_spec TEXT'],
  ['verticals', 'listed INTEGER NOT NULL DEFAULT 0'],
  ['verticals', 'publish_requested_at TEXT'],
  ['verticals', 'installs_blocked INTEGER NOT NULL DEFAULT 0'],
  ['verticals', 'tenant_provisioner INTEGER NOT NULL DEFAULT 0'],
  ['verticals', 'email_sender INTEGER NOT NULL DEFAULT 0'],
  ['verticals', 'serving_ref TEXT'],
  ['verticals', 'serving_version_id TEXT'],
  ['verticals', 'serving_do_classes TEXT'],
  ['verticals', 'serving_migration_tag TEXT'],
  ['vertical_versions', 'manifest_json TEXT'],
  ['vertical_versions', 'origin_json TEXT'],
  ['vertical_versions', 'migration_count INTEGER'],
  ['vertical_versions', 'migrations_split INTEGER'],
  ['vertical_versions', 'migration_digest_derived INTEGER'],
  ['vertical_versions', 'migrations_extracted TEXT'],
  ['_substrat_entitlements', 'expires_at TEXT'],
  ['_substrat_entitlements', 'quota INTEGER'],
  ['_substrat_entitlements', 'plan TEXT'],
  ['_substrat_entitlements', 'granted_at TEXT'],
  ['_substrat_entitlements', 'granted_by TEXT'],
];
/** Added by `buildDirectorySchema` after #1764's held-back statements, which create the first table. */
const COLUMNS_ADDED_AFTER_HELD: readonly (readonly [string, string])[] = [
  ['vertical_version_migrations', 'declarations TEXT'],
  ['_substrat_roles', 'holder TEXT'],
];
/** The indexes `ensureDirectoryColumns` creates after its columns (a copy, held as the columns are). */
const INDEXES_ADDED: readonly string[] = [
  'CREATE INDEX IF NOT EXISTS _substrat_ops_failures_fingerprint ON _substrat_ops_failures (fingerprint, id)',
  "CREATE UNIQUE INDEX IF NOT EXISTS scopes_tenant_slug ON scopes (tenant_id, slug) WHERE status NOT IN ('archived', 'reaped')",
  'CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug ON tenants (slug)',
  'CREATE UNIQUE INDEX IF NOT EXISTS orgs_tenant_slug ON orgs (tenant_id, slug)',
];

/** One step of an object's schema: a statement, or a column it ALTERs in (tolerating one already there). */
export type SchemaStep = { exec: string } | { addColumn: readonly [table: string, column: string] };

/**
 * The schema of a new directory object, in the order the directory itself builds it: the placed
 * statements of the DDL's first pass, the placed columns, #1764's held-back statements, the two
 * later columns, the placed indexes, then the object's own crossing tables.
 */
export function directoryObjectSchema(object: DirectoryObjectKind): SchemaStep[] {
  const placed = placedIn(object);
  const statements = (stmts: readonly string[]): SchemaStep[] => stmts.filter((s) => placed(tableOfStatement(s))).map((exec) => ({ exec }));
  const columns = (list: readonly (readonly [string, string])[]): SchemaStep[] => list.filter(([t]) => placed(t)).map((addColumn) => ({ addColumn }));
  return [
    ...statements(DIRECTORY_DDL_PLAN.loop),
    ...columns(DIRECTORY_COLUMNS_ADDED),
    ...statements(DIRECTORY_DDL_PLAN.afterColumns),
    ...columns(COLUMNS_ADDED_AFTER_HELD),
    ...statements(INDEXES_ADDED),
    ...executableSqlStatements(DIRECTORY_CROSSINGS_DDL).map((exec) => ({ exec })),
    ...(object === 'registry' ? executableSqlStatements(DIRECTORY_CLAIMS_DDL).map((exec) => ({ exec })) : []),
  ];
}

/** Every table the directory's DDL builds, in the order it builds them. */
export function directoryTables(): string[] {
  const tables = [...DIRECTORY_DDL_PLAN.loop, ...DIRECTORY_DDL_PLAN.afterColumns]
    .filter((s) => /^\s*CREATE\s+TABLE/i.test(s))
    .map(tableOfStatement);
  return [...new Set(tables)];
}
