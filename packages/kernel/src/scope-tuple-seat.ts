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
 * reconcile that would otherwise leave the scope with no live role grant at all re-seats
 * the owner-of-record anyway (`applyProjection`'s `lockout_reseat`), because a scope
 * nobody can act in is the #332 lockout `/internal/reconcile` exists to repair.
 *
 * Params, in order: subject, relation, object, expires_at.
 */
export const SEAT_SCOPE_TUPLE_SQL = `INSERT INTO _substrat_tuples (subject, relation, object, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT (subject, relation, object) DO UPDATE SET expires_at = excluded.expires_at
     WHERE _substrat_tuples.revoked_at IS NULL`;
