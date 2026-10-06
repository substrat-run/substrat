/**
 * `ctx.grant` / `ctx.revoke`'s writes to `_substrat_tuples`, as one statement each for both
 * adapters (#2071).
 *
 * A revoke TOMBSTONES (K-21): the row stays with `revoked_at` set, the checker's walk skips it,
 * and it stays readable as evidence that the key was taken back. It used to be a `DELETE`,
 * which left "revoked" and "never held" as the same absent row. That is the one distinction a
 * declared entity-grant shape's top-up needs (`entity-grant-shape.ts`): a key someone took back
 * from a person must not come back with the next release.
 *
 * A grant is the EXPLICIT write, so it clears a tombstone: a re-grant grants, as
 * `assignScopeRole` and `HostAdmin.grant` already do. A live row is left exactly as it is,
 * expiry included, because `ctx.grant` has never shortened or lengthened a grant it found.
 */

type Params = [string, string, string];

const refs = (principal: string, permission: string, object: string): Params => [
  `principal:${principal}`,
  `granted:${permission}`,
  object,
];

/** Insert the grant, or bring a tombstoned one back with no expiry. A live row is untouched. */
export function delegatedGrantSql(principal: string, permission: string, object: string): { sql: string; params: Params } {
  return {
    sql: `INSERT INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)
          ON CONFLICT (subject, relation, object) DO UPDATE SET revoked_at = NULL, expires_at = NULL
          WHERE _substrat_tuples.revoked_at IS NOT NULL`,
    params: refs(principal, permission, object),
  };
}

/** Tombstone a live grant. A repeat revoke, or a revoke of a grant never made, changes nothing. */
export function delegatedRevokeSql(
  principal: string,
  permission: string,
  object: string,
  at: string,
): { sql: string; params: [string, ...Params] } {
  return {
    sql: `UPDATE _substrat_tuples SET revoked_at = ?
           WHERE subject = ? AND relation = ? AND object = ? AND revoked_at IS NULL`,
    params: [at, ...refs(principal, permission, object)],
  };
}
