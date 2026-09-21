import { SYSTEM_SWITCH_OFF_PREDICATE } from './system-switch.js';

/**
 * How PROVISIONING writes a scope tuple (#1659), shared by both adapters so the two
 * cannot disagree about what a reconcile is allowed to change.
 *
 * Provisioning re-runs. A private vertical's push, the console's **Re-run provisioning**,
 * a tenant's Update and — since #1653 — every listed promote reconcile each install, and
 * each reconcile re-seats the tuples provisioning grants: the owner-of-record's role, a
 * module's `system:<module>` schedule grants (#383), the tenant's connection grants
 * (#592). It used to seat them with `INSERT OR REPLACE … revoked_at = NULL`, which does
 * more than create a missing grant: it brings back a revoked one (K-21 tombstones rather
 * than deletes, so the row is still there to be replaced). An operator's revoke of a
 * seat — and the schedule kill switch, which IS the `system:` grant — lasted only until
 * the next reconcile, and nobody was told.
 *
 * So a seat is three cases, not one:
 * - **missing** → created, live. This is #332's repair: a scope whose storage was
 *   recreated has no row at all, and a reconcile must give it one back.
 * - **live** → its `expires_at` follows the platform's, as a re-delivery always did.
 * - **tombstoned** → left exactly as it is, `revoked_at` and `expires_at` both. The row
 *   is evidence (K-21), and a reconcile has no business editing it.
 *
 * This is the PROVISIONING write only. An explicit grant — `assignScopeRole`,
 * `grantEntityLocal`, `connectorGrantLocal`, and `HostAdmin`'s `assignRole`, `grant`,
 * `grantToSystem`, `grantToConnection` and `grantToOrg` — keeps `INSERT OR REPLACE`,
 * because a re-grant is a deliberate decision to grant, and a re-grant that silently
 * kept a tombstone would lock out someone an admin just let back in. The two paths are
 * separate statements precisely so neither can inherit the other's rule.
 *
 * One exception lives beside this in the Cloudflare adapter, not in the statement: a
 * reconcile that would otherwise leave the scope with no EFFECTIVE role grant at all
 * re-seats the owner-of-record anyway (`applyProjection`'s `lockout_reseat`), because a
 * scope nobody can act in is the #332 lockout `/internal/reconcile` exists to repair.
 * "Effective" is `effectiveRoleGrantQuery`, below.
 *
 * **And a subject whose schedule kill switch is OFF gets nothing seated at all** (#1666):
 * while `system:<module>`'s `switch:off` marker is live, the seat writes no row for that
 * subject — neither a missing grant nor a live one's expiry. Otherwise a reconcile would
 * create the grant a newer version declares, live, and hand the module's system authority
 * back to a job run or a `getSystemScope` invoke while its schedules stay off. The marker
 * predicate is `SYSTEM_SWITCH_OFF_PREDICATE`, the one the gate and the grant refusal read.
 * Only a `system:` subject can carry a marker, so for every other tuple the clause is inert.
 *
 * A function rather than a bare statement because the subject is bound twice; the helper
 * owns the order, so no call site can bind five values in the wrong places.
 */
export function seatScopeTuple(
  subject: string,
  relation: string,
  object: string,
  expiresAt: string | null,
): { sql: string; params: [string, string, string, string | null, string] } {
  return {
    sql: `INSERT INTO _substrat_tuples (subject, relation, object, expires_at, revoked_at)
     SELECT ?, ?, ?, ?, NULL WHERE NOT ${SYSTEM_SWITCH_OFF_PREDICATE}
     ON CONFLICT (subject, relation, object) DO UPDATE SET expires_at = excluded.expires_at
     WHERE _substrat_tuples.revoked_at IS NULL`,
    params: [subject, relation, object, expiresAt, subject],
  };
}

/**
 * Does ANYONE hold a role this scope can actually expand? The one predicate behind both
 * halves of the lockout repair on a scope-local host: the #332 guard that refuses to flip
 * enforcement to local against nobody, and #1659's owner re-seat. One answer means
 * "locked out" means one thing in that unit.
 *
 * A live tuple is not enough. A `role:<key>` tuple — scope-level in `_substrat_tuples`, or
 * tenant-level as projected into `_substrat_tenant_tuples` — grants through its role's
 * DEFINITION, and the local checker expands a key only through a current, non-revoked
 * `_substrat_roles` row for the tenant (`getRole` answers `undefined` otherwise). A tuple
 * naming a role the vertical has since removed or renamed authorizes nobody. Counting it
 * would let a stale grant stand in for a holder, so a scope whose only live grants are
 * stale would never be repaired — the exact lockout the re-seat exists for.
 *
 * So: a non-revoked, unexpired role tuple JOINED to a non-revoked definition of the same
 * key for this tenant. Expiry is compared as ISO text, as every tuple walk here does.
 * Returns one row, `effective` 0 or 1.
 */
export function effectiveRoleGrantQuery(
  tenantId: string,
  now: string,
): { sql: string; params: [string, string, string, string] } {
  return {
    sql: `SELECT (
        EXISTS (
          SELECT 1 FROM _substrat_tuples t
            JOIN _substrat_roles r
              ON r.tenant_id = ? AND r.revoked_at IS NULL AND t.relation = 'role:' || r.role_key
           WHERE t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?)
        )
        OR EXISTS (
          SELECT 1 FROM _substrat_tenant_tuples tt
            JOIN _substrat_roles r
              ON r.tenant_id = tt.tenant_id AND r.revoked_at IS NULL AND tt.relation = 'role:' || r.role_key
           WHERE tt.tenant_id = ? AND tt.revoked_at IS NULL AND (tt.expires_at IS NULL OR tt.expires_at > ?)
        )
      ) AS effective`,
    params: [tenantId, now, tenantId, now],
  };
}
