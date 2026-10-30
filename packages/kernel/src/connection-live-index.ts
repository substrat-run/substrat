/**
 * One LIVE connection per (tenant, vertical, provider, account, owner): the directory's
 * uniqueness rule for `_substrat_connections`, shared by both adapters so they build the same
 * index (`lint:spine-ddl` reads it from here).
 *
 * Revoked rows are kept as evidence (K-21) and must not block a successor, so the index is
 * partial. The account leg is COALESCEd so a provider that never sets an `external_account_ref`
 * keeps one live connection per (tenant, vertical, provider), while a multi-account provider
 * (GitHub) holds one per account. The owner leg (#2732) is COALESCEd the same way: every
 * tenant-owned row (`owner_scope_id IS NULL`) collides on '' exactly as before, and a scope's
 * own connection is keyed apart from the tenant's and from every other scope's.
 */
export const CONNECTIONS_LIVE_INDEX =
  "CREATE UNIQUE INDEX IF NOT EXISTS _substrat_connections_live_account ON _substrat_connections (tenant_id, vertical, provider, COALESCE(external_account_ref, ''), COALESCE(owner_scope_id, '')) WHERE revoked_at IS NULL;";

/**
 * Whether a directory's `_substrat_connections_live_account` already keys on the owner, read off
 * the index's `sql` in `sqlite_master` (DO SQLite serves it and restricts `PRAGMA`, so both adapters
 * detect the same way). `false` means the index is DROPPED and created again from
 * {@link CONNECTIONS_LIVE_INDEX} in one transaction: `CREATE … IF NOT EXISTS` matches on the name
 * alone, so on an existing directory the account-only index would otherwise stay. Every existing row
 * has no owner, so the wider key admits all of them.
 */
export function connectionsLiveIndexHasOwner(indexSql: string): boolean {
  return /owner_scope_id/.test(indexSql);
}
