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
