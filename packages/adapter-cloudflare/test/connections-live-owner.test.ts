import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { ulid } from '@substrat-run/kernel';
import { ControlPlaneDO } from '../src/control-plane-do.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #2732, Durable Object half: the live-connection key gains the owner on a directory DO that
 * ALREADY HAS the account-only index and no `owner_scope_id` column, which is production. Staged by
 * constructing a second `ControlPlaneDO` over storage the first one built with the previous
 * release's shape put back: new code, old storage, which is what a deploy is.
 */
const LEGACY_INDEX =
  "CREATE UNIQUE INDEX IF NOT EXISTS _substrat_connections_live_account ON _substrat_connections (tenant_id, vertical, provider, COALESCE(external_account_ref, '')) WHERE revoked_at IS NULL";

describe('#2732: a directory DO carrying the account-only live-connection index', () => {
  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
  });

  it('re-keys the index on the owner, keeps the row tenant-owned and still a singleton, and admits a scope its own', async () => {
    const stub = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`connections-live-owner-${ulid()}`));
    const tenant = ulid();
    const legacy = ulid();
    const seen = await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('DROP INDEX _substrat_connections_live_account');
      state.storage.sql.exec('ALTER TABLE _substrat_connections DROP COLUMN owner_scope_id');
      state.storage.sql.exec(LEGACY_INDEX);
      state.storage.sql.exec(
        `INSERT INTO _substrat_connections (id, tenant_id, vertical, provider, label, status, scopes, created_by, created_at)
         VALUES (?, ?, 'acme-crm', 'planima', 'planima', 'active', '[]', 'staff', '2026-01-01T00:00:00.000Z')`,
        legacy,
        tenant,
      );

      const cp = new ControlPlaneDO(state, env);
      const sql = (state.storage.sql
        .exec("SELECT sql FROM sqlite_master WHERE name = '_substrat_connections_live_account'")
        .toArray()[0] as { sql: string }).sql;
      const connect = (ownerScopeId: string | null) =>
        cp.insertConnection({
          id: ulid(), tenantId: tenant, vertical: 'acme-crm', provider: 'planima', label: 'planima',
          externalAccountRef: null, scopes: '[]', expiresAt: null, createdBy: 'staff',
          createdAt: '2026-01-02T00:00:00.000Z', keyId: 'k', ciphertext: 'c', ownerScopeId,
        });
      let tenantRefused = '';
      try {
        connect(null);
      } catch (e) {
        tenantRefused = (e as Error).message;
      }
      connect(ulid());
      return {
        sql,
        rows: cp.listConnections({ tenantId: tenant }).map((r) => [r.id, r.owner_scope_id]),
        tenantOwned: cp.listConnections({ tenantId: tenant, ownerScopeId: null }).length,
        tenantRefused,
      };
    });
    expect(seen.sql).toContain("COALESCE(owner_scope_id, '')");
    expect(seen.rows).toHaveLength(2);
    expect(seen.rows).toContainEqual([legacy, null]);
    expect(seen.tenantOwned).toBe(1);
    expect(seen.tenantRefused).toMatch(/already has a live 'planima' connection/);
  });
});
