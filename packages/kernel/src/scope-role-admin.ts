import { principalId, type Coverage, type PermissionKey, type PrincipalId } from '@substrat-run/contracts';
import type { SwitchSql } from './system-switch.js';

/**
 * A scope's ROLE ROSTER and the two bounded writes over it (#1150), shared by both adapters
 * so the roster a dashboard reads and the rows a removal tombstones are one definition.
 *
 * Scope-level role assignments are `(principal:<id>, role:<key>, scope:<id>)` tuples in the
 * scope's own `_substrat_tuples`. That is where an invite's grant (`assignScopeRoleBounded`)
 * and the install's owner seat land, so it is the whole of "who works this installed
 * vertical" at scope level. Tenant-level roles live in the directory and are not this.
 *
 * The SQL here is plain statements over the adapter's handle. The BOUND (§5.1, K-21) is the
 * adapter's: it resolves roles and asks the checker inside the same scope task that then
 * calls `applyScopeRoleChange`, so nothing lands between the check and the write.
 */

/** One live scope-level role assignment. */
export interface ScopeRoleHolder {
  principal: PrincipalId;
  roleKey: string;
}

const PRINCIPAL = 'principal:';
const ROLE = 'role:';

/**
 * Every live scope-level role assignment at `scopeId` — not tombstoned, not expired at `now`.
 * `principal` narrows it to one holder. Expiry is judged as an instant, not as ISO text, so a
 * grant written with an offset (`+14:00`) is read the way the checker reads it.
 */
export function scopeRoleHolders(
  sql: SwitchSql,
  scopeId: string,
  now: string,
  principal?: PrincipalId,
): ScopeRoleHolder[] {
  const rows = sql.all(
    `SELECT subject, relation, expires_at FROM _substrat_tuples
      WHERE object = ? AND revoked_at IS NULL
        AND subject LIKE 'principal:%' AND relation LIKE 'role:%'${principal ? ' AND subject = ?' : ''}
      ORDER BY subject, relation`,
    `scope:${scopeId}`,
    ...(principal ? [`${PRINCIPAL}${principal}`] : []),
  );
  const at = Date.parse(now);
  return rows
    .filter((r) => r.expires_at === null || Date.parse(String(r.expires_at)) > at)
    .map((r) => ({
      principal: principalId.parse(String(r.subject).slice(PRINCIPAL.length)),
      roleKey: String(r.relation).slice(ROLE.length),
    }));
}

/**
 * Tombstone `revoke` and grant `grant` for one principal at one scope — the write half of a
 * bounded change or removal, run by the adapter in the same scope task as its bound. The
 * tombstone is K-21's (the row stays, the walk skips it); the grant is `INSERT OR REPLACE`,
 * an explicit grant clearing an earlier tombstone exactly as `assignScopeRole` does.
 */
export function applyScopeRoleChange(
  sql: SwitchSql,
  scopeId: string,
  principal: PrincipalId,
  change: { revoke: readonly string[]; grant: string | null },
  at: string,
): void {
  for (const roleKey of change.revoke) {
    if (roleKey === change.grant) continue;
    sql.run(
      `UPDATE _substrat_tuples SET revoked_at = ?
        WHERE subject = ? AND relation = ? AND object = ? AND revoked_at IS NULL`,
      at, `${PRINCIPAL}${principal}`, `${ROLE}${roleKey}`, `scope:${scopeId}`,
    );
  }
  if (change.grant !== null) {
    sql.run(
      `INSERT OR REPLACE INTO _substrat_tuples (subject, relation, object, expires_at)
       VALUES (?, ?, ?, NULL)`,
      `${PRINCIPAL}${principal}`, `${ROLE}${change.grant}`, `scope:${scopeId}`,
    );
  }
}

/**
 * Several bounds as one: covered only when every one is, missing the union. A role the
 * tenant no longer defines contributes `null` — it confers nothing, so taking it back is
 * bounded by nothing (the invite revoke's rule, #1931).
 */
export function combineCoverage(bounds: readonly (Coverage | null)[]): Coverage {
  const missing = [...new Set(bounds.flatMap((b) => (b && !b.covered ? b.missing : [])))].sort() as PermissionKey[];
  return missing.length === 0 ? { covered: true, missing: [] } : { covered: false, missing: missing as [PermissionKey, ...PermissionKey[]] };
}

/** The caller's bound for one role at the scope, or `null` when the tenant defines no such role. */
export type RoleBound = (roleKey: string) => Promise<Coverage | null>;

/**
 * Move `principal` from `from` to `to` (#1150) — the whole decision, for an adapter to run in
 * ONE scope task: `from` must be held, `to` must be defined, the caller's bound over both, then
 * the tombstone and the grant together. `not-held` and `unknown-to` wrote nothing; neither does
 * a coverage that does not cover. The adapter turns the two refusals into its own errors.
 */
export async function changeScopeRole(
  sql: SwitchSql, scopeId: string, principal: PrincipalId, from: string, to: string, now: string, bound: RoleBound,
): Promise<Coverage | 'not-held' | 'unknown-to'> {
  if (!scopeRoleHolders(sql, scopeId, now, principal).some((h) => h.roleKey === from)) return 'not-held';
  const grant = await bound(to);
  if (!grant) return 'unknown-to';
  const covered = combineCoverage([await bound(from), grant]);
  if (covered.covered) applyScopeRoleChange(sql, scopeId, principal, { revoke: [from], grant: to }, now);
  return covered;
}

/**
 * Take every scope role `principal` holds (#1150), for an adapter to run in ONE scope task: the
 * caller's bound over each (a role the tenant no longer defines is taken without one), then all
 * the tombstones, or none. `revoked` names what was taken.
 */
export async function revokeScopeRoles(
  sql: SwitchSql, scopeId: string, principal: PrincipalId, now: string, bound: RoleBound,
): Promise<{ coverage: Coverage; revoked: string[] }> {
  const held = scopeRoleHolders(sql, scopeId, now, principal).map((h) => h.roleKey);
  const covered = combineCoverage(await Promise.all(held.map(bound)));
  if (!covered.covered) return { coverage: covered, revoked: [] };
  applyScopeRoleChange(sql, scopeId, principal, { revoke: held, grant: null }, now);
  return { coverage: covered, revoked: held };
}
