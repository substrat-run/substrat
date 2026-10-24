import { runInDurableObject } from 'cloudflare:test';

/**
 * Test-only writes into a ScopeDO's projected permission tables, made straight on its storage.
 * The ScopeDO's own `projectRole` / `projectTenantTuple` / `revokeProjectedRole` RPCs had no
 * shipped caller and wrote whatever they were handed unjudged, so they were removed (#2531);
 * a suite that needs a row no host path writes seeds it here instead.
 *
 * Each write goes straight to `state.storage.sql`, outside the ScopeDO's own paths: it takes no
 * place in the DO's task queue, moves no write revision and writes no receipt, so it is for
 * seeding state before the case runs, never for standing in for a write under test.
 */
type Scope = DurableObjectStub;

/** Upsert a projected role row for `tenantId`, live (`revoked_at` NULL) — what `projectRole` wrote. */
export function seedProjectedRole(
  scope: Scope,
  tenantId: string,
  role: { key: string; permissions: string[]; source: string; holder?: 'person' | 'system' },
): Promise<void> {
  return runInDurableObject(scope, (_instance, state) => {
    state.storage.sql.exec(
      `INSERT OR REPLACE INTO _substrat_roles (tenant_id, role_key, permissions, source, holder, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      tenantId,
      role.key,
      JSON.stringify(role.permissions),
      role.source,
      role.holder ?? null,
    );
  });
}

/** Upsert a projected tenant-level tuple; `revokedAt` tombstones it. */
export function seedProjectedTenantTuple(
  scope: Scope,
  tenantId: string,
  tuple: { subject: string; relation: string; object: string; expiresAt?: string | null; revokedAt?: string | null },
): Promise<void> {
  return runInDurableObject(scope, (_instance, state) => {
    state.storage.sql.exec(
      `INSERT OR REPLACE INTO _substrat_tenant_tuples (tenant_id, subject, relation, object, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      tenantId,
      tuple.subject,
      tuple.relation,
      tuple.object,
      tuple.expiresAt ?? null,
      tuple.revokedAt ?? null,
    );
  });
}

/** Tombstone a projected role row: it stops granting and stays as evidence (K-21). */
export function tombstoneProjectedRole(scope: Scope, tenantId: string, key: string, revokedAt: string): Promise<void> {
  return runInDurableObject(scope, (_instance, state) => {
    state.storage.sql.exec(`UPDATE _substrat_roles SET revoked_at = ? WHERE tenant_id = ? AND role_key = ?`, revokedAt, tenantId, key);
  });
}
