import type Database from 'better-sqlite3';
import type { Node, RoleDefinition } from '@substrat-run/contracts';
import {
  createTupleEvaluator,
  type Clock,
  type PermissionChecker,
  type PermissionTupleReader,
  type PermissionTupleRow,
  type ScopeTupleReader,
} from '@substrat-run/kernel';

/**
 * The pure adapter's half of the built-in constrained relationship-tuple evaluator
 * (design doc §4.2, plan D-23): where the tuples live and how they are read. The
 * four-rule algebra itself — role expansion, tenancy-tree inheritance, declared entity
 * parent edges (depth ≤ 4), membership, and the proof each allow carries — is
 * `createTupleEvaluator` in the kernel, shared with the Durable-Object adapter so the
 * permission contract suite tests one evaluator rather than two copies (#969).
 *
 * Tuple placement: scope-level and entity tuples live in the scope database
 * (`_substrat_tuples`); tenant-level assignments/grants and org membership live in the
 * directory (`_substrat_tenant_tuples`). Everything is evaluated inside the caller's
 * serialization domain, so check-after-write consistency is free — the "no zookies"
 * property.
 */

export interface CheckerDeps {
  directory: Database.Database;
  /** Resolve an OPEN scope db; checks only run inside operations, so it is open. */
  scopeDb(scopeId: string): Database.Database | undefined;
  getRole(tenantId: string, key: string): RoleDefinition | undefined;
  /**
   * What "now" means when a tuple's `expires_at` is judged (#956). The host's own
   * `clock`, so a frozen or manual clock can actually expire a grant — before this
   * the evaluator read the wall clock and a scripted clock could not reach it.
   *
   * Optional and defaulting to the wall clock: a checker built without one behaves
   * exactly as it did.
   */
  clock?: Clock;
}

const TUPLE_COLUMNS = 'subject, relation, object, expires_at, revoked_at';

/**
 * The scope-local reads. Each statement is compiled at most once per decision and only if
 * that decision reaches it — the evaluator calls `tuples` once per (node object, subject)
 * pair and `grant` once per frontier candidate, so re-preparing per read recompiled the
 * same SQL several times over, while a node-level check with no entity never needs the walk
 * statements at all.
 */
const scopeReader = (db: Database.Database): ScopeTupleReader => {
  let tuplesStmt: Database.Statement | undefined;
  let grantStmt: Database.Statement | undefined;
  let parentsStmt: Database.Statement | undefined;
  return {
    tuples: (subject, relationPrefix) =>
      (tuplesStmt ??= db.prepare(
        `SELECT ${TUPLE_COLUMNS} FROM _substrat_tuples
         WHERE subject = ? AND relation LIKE ?`,
      )).all(subject, `${relationPrefix}%`) as PermissionTupleRow[],
    grant: (subject, relation, object) =>
      (grantStmt ??= db.prepare(
        `SELECT ${TUPLE_COLUMNS} FROM _substrat_tuples
         WHERE subject = ? AND relation = ? AND object = ?`,
      )).get(subject, relation, object) as PermissionTupleRow | undefined,
    parents: (object) =>
      (parentsStmt ??= db.prepare(
        `SELECT ${TUPLE_COLUMNS} FROM _substrat_tuples
         WHERE subject = ? AND relation = 'parent'`,
      )).all(object) as PermissionTupleRow[],
  };
};

/**
 * Build the evaluator described above over one host's directory, scope databases
 * and role table. Stateless per call: everything it knows it reads at check time,
 * which is what makes check-after-write consistent and what lets `deps.clock`
 * decide expiry rather than the wall clock.
 */
export function createTupleChecker(deps: CheckerDeps): PermissionChecker {
  const readNow: () => string = deps.clock ?? (() => new Date().toISOString());

  const reader: PermissionTupleReader = {
    now: readNow,
    tenantTuples: (tenantId, subject, relationPrefix) =>
      deps.directory
        .prepare(
          `SELECT ${TUPLE_COLUMNS} FROM _substrat_tenant_tuples
           WHERE tenant_id = ? AND subject = ? AND relation LIKE ?`,
        )
        .all(tenantId, subject, `${relationPrefix}%`) as PermissionTupleRow[],
    getRole: (tenantId, key) => deps.getRole(tenantId, key),
    // No scope on the node, or no open database for it, means no scope-level tuples and
    // no entity walk — the entity tuples are in that database and nowhere else.
    scopeFor: (node: Node) => {
      const db = node.scopeId ? deps.scopeDb(node.scopeId) : undefined;
      return db ? scopeReader(db) : undefined;
    },
  };

  return createTupleEvaluator(reader);
}
