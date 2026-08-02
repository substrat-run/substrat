import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, tenantId } from '@substrat-run/contracts';
import { ulid, type SqlValue } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import type { D1TenantStores } from '../src/d1.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * Per-tenant relational stores on the Cloudflare host (#301 PR-2): the ledger lives in the
 * real ControlPlaneDO (this suite runs in workerd against it), the D1 client is faked at
 * its interface — the REST client itself is covered in d1.test.ts. What this proves is the
 * lifecycle: fail-closed tenant gate, mint-once idempotency through the DO ledger, race
 * convergence (the loser's orphan is dropped), the HTTP-query store shape, and the
 * admin ledger read the deploy path derives serving-script bindings from.
 */
describe('per-tenant relational store (cloudflare host)', () => {
  beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

  const staff = platformActorId.parse(ulid());

  const fakeD1 = () => {
    const created: string[] = [];
    const removed: string[] = [];
    const queries: { ref: string; sql: string; params: readonly SqlValue[] }[] = [];
    let n = 0;
    const d1: D1TenantStores = {
      create: async (name) => {
        const ref = `db-${name}-${++n}`;
        created.push(ref);
        return ref;
      },
      remove: async (ref) => {
        removed.push(ref);
      },
      query: async (ref, sql, params = []) => {
        queries.push({ ref, sql, params });
        return { results: [{ ok: 1 }], changes: 2 };
      },
    };
    return { d1, created, removed, queries };
  };

  const world = async () => {
    const fake = fakeD1();
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      tenantStores: fake.d1,
    });
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    return { host, t, ...fake };
  };

  it('mints once and re-resolves idempotently through the DO ledger', async () => {
    const { host, t, created } = await world();
    const first = await host.provisionTenantStore(staff, { tenantId: t, vertical: 'auth', binding: 'AUTH_DB' });
    expect(first.kind).toBe('relational');
    expect(created).toHaveLength(1);

    const again = await host.provisionTenantStore(staff, { tenantId: t, vertical: 'auth', binding: 'AUTH_DB' });
    expect(again.ref).toBe(first.ref);
    expect(created).toHaveLength(1); // no second database — the ledger short-circuits

    // Distinct binding ⇒ distinct store; the ledger reads back both.
    await host.provisionTenantStore(staff, { tenantId: t, vertical: 'auth', binding: 'AUDIT_DB' });
    const ledger = await host.admin.listTenantStores(staff, { tenantId: t, vertical: 'auth' });
    expect(ledger.map((r) => r.binding).sort()).toEqual(['AUDIT_DB', 'AUTH_DB']);
    expect(ledger.every((r) => r.kind === 'relational')).toBe(true);
  });

  it('fails closed for an unknown tenant, before any Cloudflare call', async () => {
    const { host, created } = await world();
    await expect(
      host.provisionTenantStore(staff, { tenantId: tenantId.parse(ulid()), vertical: 'auth', binding: 'AUTH_DB' }),
    ).rejects.toThrow(/unknown tenant/);
    expect(created).toHaveLength(0);
  });

  it('converges a provision race on ONE canonical database and drops the orphan', async () => {
    const { host, t, created, removed } = await world();
    const [a, b] = await Promise.all([
      host.provisionTenantStore(staff, { tenantId: t, vertical: 'auth', binding: 'AUTH_DB' }),
      host.provisionTenantStore(staff, { tenantId: t, vertical: 'auth', binding: 'AUTH_DB' }),
    ]);
    expect(a.ref).toBe(b.ref);
    const ledger = await host.admin.listTenantStores(staff, { tenantId: t });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.ref).toBe(a.ref);
    // Every database minted beyond the canonical one was torn down, not orphaned.
    expect(removed.sort()).toEqual(created.filter((r) => r !== a.ref).sort());
  });

  it('openTenantStore is the HTTP-query reach: async query/exec, no in-process native', async () => {
    const { host, t, queries } = await world();
    const h = await host.provisionTenantStore(staff, { tenantId: t, vertical: 'auth', binding: 'AUTH_DB' });
    const store = host.openTenantStore(h);
    await expect(store.query('SELECT 1')).resolves.toEqual([{ ok: 1 }]);
    await expect(store.exec('CREATE TABLE x (y)')).resolves.toEqual({ changes: 2 });
    expect(store.native).toBeNull();
    expect(queries.map((q) => q.ref)).toEqual([h.ref, h.ref]);
  });

  it('refuses loudly when no D1 client is configured — never a silent half-provision', async () => {
    const bare = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
    const t = tenantId.parse(ulid());
    await bare.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await expect(
      bare.provisionTenantStore(staff, { tenantId: t, vertical: 'auth', binding: 'AUTH_DB' }),
    ).rejects.toThrow(/not configured/);
    expect(() => bare.openTenantStore({ binding: 'AUTH_DB', kind: 'relational', ref: 'db-x' })).toThrow(
      /not configured/,
    );
  });
});
