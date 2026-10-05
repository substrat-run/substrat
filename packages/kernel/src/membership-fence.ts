/**
 * The removal fence (#1184): one row per (tenant, principal), stamped with the latest moment
 * that person was removed at the tenant level. The membership executor's add reads it inside
 * the directory unit that assigns the role, and applies nothing when it stands at or after
 * the request's `occurredAt - MEMBERSHIP_REMOVAL_SKEW_MS`.
 *
 * A table of its own rather than a read of the admin log, because K-21's audit contract
 * writes no row for a removal that took nothing — and a removal of someone whose add is still
 * on its way takes nothing, yet must still win. Every tenant-level `unassignRole` and every
 * `removeMember` raises it in the SAME unit as its revoke, staff's and the executor's alike,
 * a no-op included. Never lowered: a later removal moves it forward, an earlier one does not.
 *
 * The admin log is still the history. This is only the latest position.
 */

/**
 * The table. Interpolated into both adapters' directory DDL, so `lint:spine-ddl` sees the one
 * spelling on each side, and a directory dump carries it like every other directory table.
 */
export const MEMBERSHIP_FENCES_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_membership_fences (
    tenant_id  TEXT NOT NULL,
    principal  TEXT NOT NULL,
    removed_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, principal)
  );
`;

/** Raise `principal`'s fence to `removed_at`, never lower it. Binds tenant, principal, at. */
export const RAISE_MEMBERSHIP_FENCE_SQL = `
  INSERT INTO _substrat_membership_fences (tenant_id, principal, removed_at) VALUES (?, ?, ?)
  ON CONFLICT (tenant_id, principal) DO UPDATE SET removed_at = MAX(removed_at, excluded.removed_at)
`;

/** The fence, if it stands at or after an instant. Binds tenant, principal, since. */
export const MEMBERSHIP_FENCE_SINCE_SQL = `
  SELECT removed_at FROM _substrat_membership_fences
  WHERE tenant_id = ? AND principal = ? AND removed_at >= ?
`;

/** The fence's table name, as the DDL above spells it. */
export const MEMBERSHIP_FENCES_TABLE = '_substrat_membership_fences';

/**
 * The one-time backfill from the admin log: every tenant-level removal made before the fence
 * existed. Without it, an add requested back then and never effected — the backlog a host that
 * mounts the executor for the first time drains — would re-admit someone removed by hand since,
 * because the fence would have nothing to say about them.
 *
 * It reads what those removals wrote: an `unassignRole` row at the tenant node (`scope_id`
 * NULL) carries the assignment as `before.principalId`, a `removeMember` row the membership as
 * `before.principal`. A no-op removal wrote no row and is not recovered — nothing before the
 * fence recorded one. The latest per (tenant, principal) is taken.
 *
 * `INSERT OR IGNORE`, so a fence the live path raised is never lowered by history. The adapters
 * run it on the construction that creates the table, and a directory restore runs it when the
 * dump did not carry the table, so it runs once per directory that never had it.
 */
export const MEMBERSHIP_FENCES_BACKFILL_SQL = `
  INSERT OR IGNORE INTO _substrat_membership_fences (tenant_id, principal, removed_at)
  SELECT tenant_id, principal, MAX(at)
    FROM (
      SELECT tenant_id, json_extract(before, '$.principalId') AS principal, at
        FROM _substrat_admin_log
       WHERE action = 'unassignRole' AND tenant_id IS NOT NULL AND scope_id IS NULL
      UNION ALL
      SELECT tenant_id, json_extract(before, '$.principal') AS principal, at
        FROM _substrat_admin_log
       WHERE action = 'removeMember' AND tenant_id IS NOT NULL
    )
   WHERE principal IS NOT NULL
   GROUP BY tenant_id, principal
`;

/** "Does the fence table exist yet?" — asked BEFORE the DDL, so the backfill runs once. */
export function membershipFencesTableExists(db: { all(sql: string, ...params: string[]): unknown[] }): boolean {
  return db.all(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`, MEMBERSHIP_FENCES_TABLE).length > 0;
}

/** Does a dump carry the fence table? Compared without case, as SQLite resolves a name. */
export function dumpCarriesMembershipFences(names: readonly string[]): boolean {
  return names.some((n) => n.toLowerCase() === MEMBERSHIP_FENCES_TABLE);
}
