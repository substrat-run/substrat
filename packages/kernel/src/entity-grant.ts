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

import { PermissionDenied } from './permission-checker.js';
import type { SwitchSql } from './system-switch.js';

type Params = [string, string, string];

/**
 * A key only its shape may give, stored on the scope's tuple spine: every current and retired key of
 * a reconciled `'grantee'` or binding shape (#2083, #1686). The stored relation keeps its first name.
 */
export const SHAPE_PROTECTED_KEY_RELATION = 'shape-grantee-key';

/**
 * The entity types whose shape protects a `granted:<key>` relation, as `entity_type` rows. The
 * subject range keeps it on the primary key: `shape:` rows only. One spelling for the two places
 * that ask: the explicit writer below refuses the key on a record of such a type, and the
 * permission walk stops at one for that key (`permission-eval.ts`, #2177).
 *
 * The range's bounds are parameters, not literals: the scope DO judges whether a statement writes
 * by its text (`isWriteStatement`), and a `;` inside a literal would read as a second statement,
 * counting every check that asks as a write.
 */
export function shapeProtectedTypesQuery(relation: string): { sql: string; params: [string, string, string, string] } {
  return {
    sql: `SELECT substr(subject, ${'shape:'.length + 1}) AS entity_type FROM _substrat_tuples
          WHERE subject >= ? AND subject < ? AND relation = ? AND object = ?`,
    params: ['shape:', 'shape;', SHAPE_PROTECTED_KEY_RELATION, relation],
  };
}

/** Every explicit non-shape scope tuple write uses this guard, including administrative writes. */
function assertDelegableTuple(db: SwitchSql, relation: string, object: string): void {
  if (!relation.startsWith('granted:')) return;
  const colon = object.indexOf(':');
  if (colon < 0) return;
  const entityType = object.slice(0, colon);
  const q = shapeProtectedTypesQuery(relation);
  if ((db.all(q.sql, ...q.params) as { entity_type: string }[]).some((r) => r.entity_type === entityType)) {
    throw new PermissionDenied(
      `cannot grant '${relation.slice('granted:'.length)}' on ${object} — ` +
        `it is a key of the declared '${entityType}' shape, given only by the shape grant`,
    );
  }
}

/** The explicit scope-tuple write for admin/local grants and ctx.grant, behind one shape guard. */
export function writeExplicitTupleIn(
  db: SwitchSql,
  subject: string,
  relation: string,
  object: string,
  mode: { kind: 'replace'; expiresAt: string | null } | { kind: 'delegated' },
): void {
  assertDelegableTuple(db, relation, object);
  if (mode.kind === 'replace') {
    db.run(
      'INSERT OR REPLACE INTO _substrat_tuples (subject, relation, object, expires_at) VALUES (?, ?, ?, ?)',
      subject,
      relation,
      object,
      mode.expiresAt,
    );
  } else {
    const grant = explicitTupleSql(subject, relation, object);
    db.run(grant.sql, ...grant.params);
  }
}

const refs = (principal: string, permission: string, object: string): Params => [
  `principal:${principal}`,
  `granted:${permission}`,
  object,
];

/**
 * The explicit tuple write: insert it, or bring a tombstoned one back with no expiry. A live
 * row is untouched. `ctx.grant` and a declared shape's grant (`entity-grant-shape.ts`) share it.
 */
export function explicitTupleSql(subject: string, relation: string, object: string): { sql: string; params: Params } {
  return {
    sql: `INSERT INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)
          ON CONFLICT (subject, relation, object) DO UPDATE SET revoked_at = NULL, expires_at = NULL
          WHERE _substrat_tuples.revoked_at IS NOT NULL`,
    params: [subject, relation, object],
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
