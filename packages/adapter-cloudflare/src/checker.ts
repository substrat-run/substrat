import {
  objectRef,
  subjectRef,
  type Decision,
  type EntitlementView,
  type EntityRef,
  type Node,
  type PermissionKey,
  type CheckSubject,
  type RelationTuple,
  type RoleDefinition,
} from '@substrat-run/contracts';
import type { PermissionChecker } from '@substrat-run/kernel';

/**
 * The built-in constrained relationship-tuple evaluator (design doc §4.2, plan
 * D-23), ported to the Durable-Object split. Identical four-rule algebra to the
 * pure adapter's `createTupleChecker` — role expansion, tenancy-tree
 * inheritance, declared entity parent edges (depth ≤ 4), membership — no
 * negation, no configurable rewrites. Every allow carries its tuple proof.
 *
 * Tuple placement mirrors the pure adapter, split across DOs: scope-level and
 * entity tuples live in THIS ScopeDO's SQLite (`_substrat_tuples`, read
 * synchronously); tenant-level assignments/grants, roles, and org membership
 * live in the ControlPlaneDO and are reached over RPC (async). The whole
 * evaluation still runs inside the ScopeDO's serialization domain, so
 * check-after-write consistency holds — the "no zookies" property.
 */

const ENTITY_WALK_DEPTH = 4;

interface TupleRow {
  subject: string;
  relation: string;
  object: string;
  expires_at: string | null;
  revoked_at: string | null;
}

/** The slice of the ControlPlaneDO the checker (and the entitlement read surface) consult for
 *  tenant-level data. `listEntitlements` returns only CURRENTLY-HELD grants (expiry applied at
 *  read), so "the tenant holds key K" is exactly "K is in the returned list" — #304. */
export interface ControlPlaneReader {
  tenantTuples(tenantId: string, subject: string, relationPrefix: string): Promise<TupleRow[]>;
  getRole(tenantId: string, key: string): Promise<RoleDefinition | undefined>;
  listEntitlements(tenantId: string): Promise<EntitlementView[]>;
}

export interface DoCheckerDeps {
  /** This ScopeDO's own SQL storage — scope + entity tuples live here. */
  scopeSql: SqlStorage;
  /** Tenant-level tuples + roles live in the ControlPlaneDO. */
  controlPlane: ControlPlaneReader;
}

/**
 * A `ControlPlaneReader` backed by the ScopeDO's OWN storage — the read side of
 * scope-local permissions (docs/design/scope-local-permissions.md). It reads the
 * tenant-level tuples + role definitions that were **projected** into this scope
 * (`_substrat_tenant_tuples`, `_substrat_roles`), so the checker never has to call
 * the shared control-plane DO on the request path.
 *
 * It returns exactly what the RPC reader returns — rows (including tombstoned ones,
 * which the checker's own `live()` filter drops), and a role or `undefined`. An
 * empty projection therefore yields `[]` / `undefined`, i.e. **deny** — fail closed.
 * A revoked role definition is treated as absent (returns `undefined`), so a removed
 * role stops granting the moment its tombstone is projected.
 */
export function createLocalControlPlaneReader(sql: SqlStorage): ControlPlaneReader {
  return {
    async tenantTuples(tenantId, subject, relationPrefix): Promise<TupleRow[]> {
      return sql
        .exec(
          `SELECT subject, relation, object, expires_at, revoked_at FROM _substrat_tenant_tuples
           WHERE tenant_id = ? AND subject = ? AND relation LIKE ?`,
          tenantId,
          subject,
          `${relationPrefix}%`,
        )
        .toArray() as unknown as TupleRow[];
    },
    async getRole(tenantId, key): Promise<RoleDefinition | undefined> {
      const row = sql
        .exec(
          `SELECT role_key, permissions, source FROM _substrat_roles
           WHERE tenant_id = ? AND role_key = ? AND revoked_at IS NULL`,
          tenantId,
          key,
        )
        .toArray()[0] as { role_key: string; permissions: string; source: string } | undefined;
      if (!row) return undefined;
      return { key: row.role_key, permissions: JSON.parse(row.permissions), source: row.source } as RoleDefinition;
    },
    async listEntitlements(tenantId): Promise<EntitlementView[]> {
      // Only currently-held grants: an expired row is absent from the view exactly as it is
      // absent from the gate (#33/#304). ISO instants compare lexically, evaluated at read.
      const rows = sql
        .exec(
          `SELECT entitlement_key, plan, quota, expires_at FROM _substrat_entitlements
           WHERE tenant_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
          tenantId,
          new Date().toISOString(),
        )
        .toArray() as unknown as {
        entitlement_key: string;
        plan: string | null;
        quota: number | null;
        expires_at: string | null;
      }[];
      return rows.map((r) => ({
        key: r.entitlement_key,
        plan: r.plan,
        quota: r.quota,
        expiresAt: r.expires_at as EntitlementView['expiresAt'],
      }));
    },
  };
}

const t = (subject: string, relation: string, object: string): RelationTuple => ({
  subject: objectRef.parse(subject),
  relation,
  object: objectRef.parse(object),
});

export function createDoTupleChecker(deps: DoCheckerDeps): PermissionChecker {
  const scopeTuples = (subject: string, relationPrefix: string): TupleRow[] =>
    deps.scopeSql
      .exec(
        `SELECT subject, relation, object, expires_at, revoked_at FROM _substrat_tuples
         WHERE subject = ? AND relation LIKE ?`,
        subject,
        `${relationPrefix}%`,
      )
      .toArray() as unknown as TupleRow[];

  // A tuple grants only while it is unexpired AND unrevoked. K-21: revocation
  // tombstones rather than deletes, so a revoked row is still here and still
  // readable as evidence — it just stops granting.
  const live = (row: TupleRow, now: string): boolean =>
    (row.expires_at === null || row.expires_at > now) && row.revoked_at === null;

  return {
    async check(
      subject: CheckSubject,
      permission: PermissionKey,
      node: Node,
      entity?: EntityRef,
    ): Promise<Decision> {
      const now = new Date().toISOString();
      const deny: Decision = { allowed: false, checked: permission, node };
      const cp = deps.controlPlane;

      // Rule 4 — membership: the subject set is the caller plus its orgs.
      //
      // A CONNECTION has no memberships and never will — it is not a person and
      // belongs to no org — so the expansion is skipped rather than queried.
      // Its authority is exactly the grants written against `connection:<id>`.
      const selfRef = subjectRef(subject);
      const subjects: { ref: string; via?: RelationTuple }[] = [{ ref: selfRef }];
      if (subject.kind === 'principal') {
        for (const m of await cp.tenantTuples(node.tenantId, selfRef, 'member')) {
          if (m.relation === 'member' && live(m, now)) {
            subjects.push({ ref: m.object, via: t(m.subject, m.relation, m.object) });
          }
        }
      }

      // Inheritance (rule 2): a scope check also consults tenant-level tuples.
      const nodeObjects: { obj: string; scoped: boolean }[] = node.scopeId
        ? [
            { obj: `scope:${node.scopeId}`, scoped: true },
            { obj: `tenant:${node.tenantId}`, scoped: false },
          ]
        : [{ obj: `tenant:${node.tenantId}`, scoped: false }];

      const tuplesFor = async (
        subject: string,
        prefix: string,
        scoped: boolean,
      ): Promise<TupleRow[]> =>
        scoped ? scopeTuples(subject, prefix) : cp.tenantTuples(node.tenantId, subject, prefix);

      for (const nodeObj of nodeObjects) {
        for (const subject of subjects) {
          // Rule 1 — role expansion.
          for (const row of await tuplesFor(subject.ref, 'role:', nodeObj.scoped)) {
            if (row.object !== nodeObj.obj || !live(row, now)) continue;
            const roleKey = row.relation.slice('role:'.length);
            const role = await cp.getRole(node.tenantId, roleKey);
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
          for (const row of await tuplesFor(subject.ref, `granted:${permission}`, nodeObj.scoped)) {
            if (
              row.object === nodeObj.obj &&
              row.relation === `granted:${permission}` &&
              live(row, now)
            ) {
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
      if (entity) {
        type Frontier = { ref: string; chain: RelationTuple[] };
        let frontier: Frontier[] = [{ ref: `${entity.entityType}:${entity.entityId}`, chain: [] }];
        for (let depth = 0; depth <= ENTITY_WALK_DEPTH && frontier.length > 0; depth++) {
          // grant lookup at current frontier objects
          for (const candidate of frontier) {
            for (const subject of subjects) {
              const grant = deps.scopeSql
                .exec(
                  `SELECT subject, relation, object, expires_at, revoked_at FROM _substrat_tuples
                   WHERE subject = ? AND relation = ? AND object = ?`,
                  subject.ref,
                  `granted:${permission}`,
                  candidate.ref,
                )
                .toArray()[0] as unknown as TupleRow | undefined;
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
            const parents = deps.scopeSql
              .exec(
                `SELECT subject, relation, object, expires_at, revoked_at FROM _substrat_tuples
                 WHERE subject = ? AND relation = 'parent'`,
                candidate.ref,
              )
              .toArray() as unknown as TupleRow[];
            for (const p of parents) {
              // A revoked parent edge stops expanding — without this the tombstone
              // would work for grants and membership but silently NOT for entity
              // edges, which is the case open question 15 is actually about.
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
