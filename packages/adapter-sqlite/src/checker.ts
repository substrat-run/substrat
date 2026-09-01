import type Database from 'better-sqlite3';
import {
  objectRef,
  subjectRef,
  type Coverage,
  type Decision,
  type EntityRef,
  type Node,
  type PermissionKey,
  type CheckSubject,
  type RelationTuple,
  type RoleDefinition,
} from '@substrat-run/contracts';
import type { Clock, PermissionChecker } from '@substrat-run/kernel';

/**
 * The built-in constrained relationship-tuple evaluator (design doc §4.2,
 * plan D-23). Fixed four-rule algebra — role expansion, tenancy-tree
 * inheritance, declared entity parent edges (depth ≤ 4), membership — no
 * negation, no configurable rewrites. Every allow carries its tuple proof.
 *
 * Tuple placement: scope-level and entity tuples live in the scope database
 * (`_substrat_tuples`); tenant-level assignments/grants and org membership
 * live in the directory (`_substrat_tenant_tuples`). Everything is evaluated
 * inside the caller's serialization domain, so check-after-write consistency
 * is free — the "no zookies" property.
 */

const ENTITY_WALK_DEPTH = 4;

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

interface TupleRow {
  subject: string;
  relation: string;
  object: string;
  expires_at: string | null;
  revoked_at: string | null;
}

const t = (subject: string, relation: string, object: string): RelationTuple => ({
  subject: objectRef.parse(subject),
  relation,
  object: objectRef.parse(object),
});

/**
 * Build the evaluator described above over one host's directory, scope databases
 * and role table. Stateless per call: everything it knows it reads at check time,
 * which is what makes check-after-write consistent and what lets `deps.clock`
 * decide expiry rather than the wall clock.
 */
export function createTupleChecker(deps: CheckerDeps): PermissionChecker {
  const readNow: () => string = deps.clock ?? (() => new Date().toISOString());

  const tenantTuples = (tenantId: string, subject: string, relationPrefix: string): TupleRow[] =>
    deps.directory
      .prepare(
        `SELECT subject, relation, object, expires_at, revoked_at FROM _substrat_tenant_tuples
         WHERE tenant_id = ? AND subject = ? AND relation LIKE ?`,
      )
      .all(tenantId, subject, `${relationPrefix}%`) as TupleRow[];

  const scopeTuples = (
    db: Database.Database,
    subject: string,
    relationPrefix: string,
  ): TupleRow[] =>
    db
      .prepare(
        `SELECT subject, relation, object, expires_at, revoked_at FROM _substrat_tuples
         WHERE subject = ? AND relation LIKE ?`,
      )
      .all(subject, `${relationPrefix}%`) as TupleRow[];

  // A tuple grants only while it is unexpired AND unrevoked. K-21: revocation
  // tombstones rather than deletes, so a revoked row is still here and still
  // readable as evidence — it just stops granting. Same predicate, same sites as
  // `expires_at`, so there is one definition of "live" rather than two.
  const live = (row: TupleRow, now: string): boolean =>
    (row.expires_at === null || row.expires_at > now) && row.revoked_at === null;

  /**
   * The subject set a check reasons over: the caller, plus every org it is a live
   * member of (rule 4). Shared by `check` and `covers` so the two cannot disagree about
   * who someone is — a divergence here would let the bound be computed over a smaller
   * subject set than the check that later allows the action.
   *
   * A CONNECTION has no memberships and never will (#97): its authority is exactly the
   * grants written against `connection:<id>`.
   */
  const subjectsOf = (
    subject: CheckSubject,
    node: Node,
    now: string,
  ): { ref: string; via?: RelationTuple }[] => {
    const selfRef = subjectRef(subject);
    const out: { ref: string; via?: RelationTuple }[] = [{ ref: selfRef }];
    for (const m of subject.kind === 'principal'
      ? tenantTuples(node.tenantId, selfRef, 'member')
      : []) {
      if (m.relation === 'member' && live(m, now)) {
        out.push({ ref: m.object, via: t(m.subject, m.relation, m.object) });
      }
    }
    return out;
  };

  return {
    /**
     * The subject's effective permission set at the node, compared against `required`.
     *
     * Reads every `role:` and `granted:` tuple for each subject at each node object in
     * one pass — two statements per (subject, level) pair — rather than re-walking per
     * permission. Entity tuples are never consulted, which is what makes this
     * narrowing-aware: an entity-narrowed grant has an `entityType:entityId` object and
     * so matches no node object here, by construction rather than by a filter someone
     * has to remember.
     */
    async covers(
      subject: CheckSubject,
      required: readonly PermissionKey[],
      node: Node,
    ): Promise<Coverage> {
      // Nothing required is trivially covered — and asking the database would be a walk
      // to prove the empty set is a subset of anything.
      if (required.length === 0) return { covered: true, missing: [] };

      const now = readNow();
      const scopeDb = node.scopeId ? deps.scopeDb(node.scopeId) : undefined;
      const subjects = subjectsOf(subject, node, now);
      const nodeObjects: { obj: string; scoped: boolean }[] = node.scopeId
        ? [
            { obj: `scope:${node.scopeId}`, scoped: true },
            { obj: `tenant:${node.tenantId}`, scoped: false },
          ]
        : [{ obj: `tenant:${node.tenantId}`, scoped: false }];

      const held = new Set<string>();
      for (const nodeObj of nodeObjects) {
        for (const s of subjects) {
          const rows = nodeObj.scoped
            ? scopeDb
              ? scopeTuples(scopeDb, s.ref, '')
              : []
            : tenantTuples(node.tenantId, s.ref, '');
          for (const row of rows) {
            if (row.object !== nodeObj.obj || !live(row, now)) continue;
            if (row.relation.startsWith('role:')) {
              const role = deps.getRole(node.tenantId, row.relation.slice('role:'.length));
              for (const p of role?.permissions ?? []) held.add(p);
            } else if (row.relation.startsWith('granted:')) {
              held.add(row.relation.slice('granted:'.length));
            }
          }
        }
      }

      // Order follows the request so a refusal reads predictably; deduplicated so a
      // caller passing the same key twice does not see it twice.
      const missing: PermissionKey[] = [];
      for (const p of required) {
        if (!held.has(p) && !missing.includes(p)) missing.push(p);
      }
      return missing.length === 0 ? { covered: true, missing: [] } : { covered: false, missing };
    },

    async check(
      subject: CheckSubject,
      permission: PermissionKey,
      node: Node,
      entity?: EntityRef,
    ): Promise<Decision> {
      const now = readNow();
      const deny: Decision = { allowed: false, checked: permission, node };
      const scopeDb = node.scopeId ? deps.scopeDb(node.scopeId) : undefined;

      // Rule 4 — membership: the subject set is the caller plus its orgs. Shared with
      // `covers` (§ `subjectsOf`), so the bound and the check cannot disagree about who
      // someone is — a divergence there would compute the bound over a smaller subject
      // set than the check that later allows the action.
      const subjects = subjectsOf(subject, node, now);

      // Inheritance (rule 2): a scope check also consults tenant-level tuples.
      const nodeObjects: { obj: string; scoped: boolean }[] = node.scopeId
        ? [
            { obj: `scope:${node.scopeId}`, scoped: true },
            { obj: `tenant:${node.tenantId}`, scoped: false },
          ]
        : [{ obj: `tenant:${node.tenantId}`, scoped: false }];

      const tuplesFor = (subject: string, prefix: string, scoped: boolean): TupleRow[] =>
        scoped
          ? scopeDb
            ? scopeTuples(scopeDb, subject, prefix)
            : []
          : tenantTuples(node.tenantId, subject, prefix);

      for (const nodeObj of nodeObjects) {
        for (const subject of subjects) {
          // Rule 1 — role expansion.
          for (const row of tuplesFor(subject.ref, 'role:', nodeObj.scoped)) {
            if (row.object !== nodeObj.obj || !live(row, now)) continue;
            const roleKey = row.relation.slice('role:'.length);
            const role = deps.getRole(node.tenantId, roleKey);
            if (role?.permissions.includes(permission)) {
              return {
                allowed: true,
                proof: [
                  ...(subject.via ? [subject.via] : []),
                  t(row.subject, row.relation, row.object),
                  t(`role:${roleKey}`, `granted:${permission}`, nodeObj.obj),
                ],
              };
            }
          }
          // Direct grants at the node.
          for (const row of tuplesFor(subject.ref, `granted:${permission}`, nodeObj.scoped)) {
            if (row.object === nodeObj.obj && row.relation === `granted:${permission}` && live(row, now)) {
              return {
                allowed: true,
                proof: [
                  ...(subject.via ? [subject.via] : []),
                  t(row.subject, row.relation, row.object),
                ],
              };
            }
          }
        }
      }

      // Rule 3 — entity walk along declared parent edges (entity grants are
      // scope-local by construction).
      if (entity && scopeDb) {
        type Frontier = { ref: string; chain: RelationTuple[] };
        let frontier: Frontier[] = [
          { ref: `${entity.entityType}:${entity.entityId}`, chain: [] },
        ];
        for (let depth = 0; depth <= ENTITY_WALK_DEPTH && frontier.length > 0; depth++) {
          // grant lookup at current frontier objects
          for (const candidate of frontier) {
            for (const subject of subjects) {
              const grant = scopeDb
                .prepare(
                  `SELECT subject, relation, object, expires_at, revoked_at FROM _substrat_tuples
                   WHERE subject = ? AND relation = ? AND object = ?`,
                )
                .get(subject.ref, `granted:${permission}`, candidate.ref) as
                | TupleRow
                | undefined;
              if (grant && live(grant, now)) {
                return {
                  allowed: true,
                  proof: [
                    ...(subject.via ? [subject.via] : []),
                    ...candidate.chain,
                    t(grant.subject, grant.relation, grant.object),
                  ],
                };
              }
            }
          }
          // expand one level of parents
          const next: Frontier[] = [];
          for (const candidate of frontier) {
            const parents = scopeDb
              .prepare(
                `SELECT subject, relation, object, expires_at, revoked_at FROM _substrat_tuples
                 WHERE subject = ? AND relation = 'parent'`,
              )
              .all(candidate.ref) as TupleRow[];
            for (const p of parents) {
              // A revoked parent edge stops expanding. Without this the tombstone
              // would work for grants and membership but silently NOT for entity
              // edges — which is the case open question 15 is actually about
              // (a facility moving management company must stop being reachable).
              if (!live(p, now)) continue;
              next.push({
                ref: p.object,
                chain: [...candidate.chain, t(p.subject, 'parent', p.object)],
              });
            }
          }
          frontier = next;
        }
      }

      return deny;
    },
  };
}
