import type { EntitlementView, RoleDefinition } from '@substrat-run/contracts';
import {
  createTupleEvaluator,
  type PermissionChecker,
  type PermissionTupleReader,
  type PermissionTupleRow,
  type ScopeTupleReader,
} from '@substrat-run/kernel';

/**
 * The Durable-Object adapter's half of the built-in constrained relationship-tuple
 * evaluator (design doc §4.2, plan D-23): where the tuples live and how they are read.
 * The four-rule algebra itself — role expansion, tenancy-tree inheritance, declared
 * entity parent edges (depth ≤ 4), membership, and the proof each allow carries — is
 * `createTupleEvaluator` in the kernel, shared with the pure adapter so the permission
 * contract suite tests one evaluator rather than two copies (#969).
 *
 * Tuple placement mirrors the pure adapter, split across DOs: scope-level and
 * entity tuples live in THIS ScopeDO's SQLite (`_substrat_tuples`, read
 * synchronously); tenant-level assignments/grants, roles, and org membership
 * live in the ControlPlaneDO and are reached over RPC (async) — which is why the
 * kernel evaluator lets every read be a promise. The whole evaluation still runs
 * inside the ScopeDO's serialization domain, so check-after-write consistency
 * holds — the "no zookies" property.
 */

type TupleRow = PermissionTupleRow;

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
 * scope-local permissions (docs/architecture/scope-local-permissions.md). It reads the
 * tenant-level tuples + role definitions that were **projected** into this scope
 * (`_substrat_tenant_tuples`, `_substrat_roles`), so the checker never has to call
 * the shared control-plane DO on the request path.
 *
 * It returns exactly what the RPC reader returns — rows (including tombstoned ones,
 * which the evaluator's own `live()` filter drops), and a role or `undefined`. An
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

const TUPLE_COLUMNS = 'subject, relation, object, expires_at, revoked_at';

/**
 * The scope-local reads, straight off this ScopeDO's own SQL — synchronous, because the
 * storage is right here. Entity-narrowed grants and the declared `parent` edges are
 * scope-local by construction, so they sit beside the scope-level tuples.
 */
const scopeReader = (sql: SqlStorage): ScopeTupleReader => ({
  tuples: (subject, relationPrefix) =>
    sql
      .exec(
        `SELECT ${TUPLE_COLUMNS} FROM _substrat_tuples
         WHERE subject = ? AND relation LIKE ?`,
        subject,
        `${relationPrefix}%`,
      )
      .toArray() as unknown as TupleRow[],
  grant: (subject, relation, object) =>
    sql
      .exec(
        `SELECT ${TUPLE_COLUMNS} FROM _substrat_tuples
         WHERE subject = ? AND relation = ? AND object = ?`,
        subject,
        relation,
        object,
      )
      .toArray()[0] as unknown as TupleRow | undefined,
  parents: (object) =>
    sql
      .exec(
        `SELECT ${TUPLE_COLUMNS} FROM _substrat_tuples
         WHERE subject = ? AND relation = 'parent'`,
        object,
      )
      .toArray() as unknown as TupleRow[],
});

export function createDoTupleChecker(deps: DoCheckerDeps): PermissionChecker {
  const scope = scopeReader(deps.scopeSql);

  const reader: PermissionTupleReader = {
    now: () => new Date().toISOString(),
    tenantTuples: (tenantId, subject, relationPrefix) =>
      deps.controlPlane.tenantTuples(tenantId, subject, relationPrefix),
    getRole: (tenantId, key) => deps.controlPlane.getRole(tenantId, key),
    // A ScopeDO *is* one scope, so its own storage is always the scope store — there is no
    // id to resolve and no "database not open" case to answer for.
    scopeFor: () => scope,
  };

  return createTupleEvaluator(reader);
}
