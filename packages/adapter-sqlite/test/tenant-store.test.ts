import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { platformActorId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * Per-tenant relational stores (#301) on the pure adapter — the local mimic of a per-tenant
 * D1: one separate `.sqlite` file per (tenant, vertical, binding), physically isolated from
 * the scope DBs. These properties are pure-adapter-specific (they read the data directory and
 * open the minted file directly), so they live here rather than the shared contract suite —
 * the Cloudflare adapter's live-D1 implementation is #301 PR-2.
 */
describe('per-tenant relational store (pure adapter)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const world = async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-tstore-'));
    const host = new SqliteScopeHost({ dir });
    const staff = platformActorId.parse(ulid());
    const a = tenantId.parse(ulid());
    const b = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: a, slug: 'alpha', name: 'Alpha' });
    await host.admin.createTenant(staff, { id: b, slug: 'bravo', name: 'Bravo' });
    return { host, staff, a, b, dir: dir! };
  };

  it('mints one isolated store per tenant; data never crosses', async () => {
    const { host, staff, a, b } = await world();

    const ha = await host.provisionTenantStore(staff, { tenantId: a, vertical: 'auth', binding: 'AUTH_DB' });
    const hb = await host.provisionTenantStore(staff, { tenantId: b, vertical: 'auth', binding: 'AUTH_DB' });

    // Distinct tenants ⇒ distinct opaque refs ⇒ distinct backing files.
    expect(ha.ref).not.toBe(hb.ref);
    expect(ha.kind).toBe('relational');
    expect(ha.binding).toBe('AUTH_DB');

    // The vertical opens each and runs its OWN migrations against it.
    for (const h of [ha, hb]) {
      host.openTenantStore(h).exec('CREATE TABLE users (email TEXT PRIMARY KEY)');
    }
    host.openTenantStore(ha).exec('INSERT INTO users (email) VALUES (?)', ['a@alpha.example']);
    host.openTenantStore(hb).exec('INSERT INTO users (email) VALUES (?)', ['b@bravo.example']);

    // Isolation: each store sees only its own tenant's row.
    expect(host.openTenantStore(ha).query('SELECT email FROM users')).toEqual([{ email: 'a@alpha.example' }]);
    expect(host.openTenantStore(hb).query('SELECT email FROM users')).toEqual([{ email: 'b@bravo.example' }]);
  });

  it('physically separates each store into its own .sqlite file, apart from scope DBs', async () => {
    const { host, staff, a, dir } = await world();
    const h = await host.provisionTenantStore(staff, { tenantId: a, vertical: 'auth', binding: 'AUTH_DB' });

    // The ref is a bare filename that resolves to a real, separate file on disk.
    expect(h.ref).not.toContain('/');
    expect(existsSync(join(dir, h.ref))).toBe(true);
    // It is NOT the shared directory DB and carries the tstore prefix that keeps it clear of
    // scope files (`${tenantId}__${scopeId}.sqlite`).
    expect(h.ref.startsWith('tstore__')).toBe(true);
    expect(h.ref).not.toBe('_directory.sqlite');
  });

  it('is idempotent: re-provisioning re-resolves the same store, never a second file', async () => {
    const { host, staff, a, dir } = await world();
    const first = await host.provisionTenantStore(staff, { tenantId: a, vertical: 'auth', binding: 'AUTH_DB' });
    host.openTenantStore(first).exec('CREATE TABLE t (x INTEGER)');
    host.openTenantStore(first).exec('INSERT INTO t (x) VALUES (1)');

    const again = await host.provisionTenantStore(staff, { tenantId: a, vertical: 'auth', binding: 'AUTH_DB' });
    expect(again.ref).toBe(first.ref);
    // The retried provision must not orphan a second database, and the data survives.
    // Count only the DB files, not WAL/-shm sidecars.
    expect(readdirSync(dir).filter((f) => f.startsWith('tstore__') && f.endsWith('.sqlite'))).toHaveLength(1);
    expect(host.openTenantStore(again).query('SELECT x FROM t')).toEqual([{ x: 1 }]);
  });

  it('keeps a tenant’s two declared bindings in separate stores', async () => {
    const { host, staff, a } = await world();
    const authDb = await host.provisionTenantStore(staff, { tenantId: a, vertical: 'auth', binding: 'AUTH_DB' });
    const auditDb = await host.provisionTenantStore(staff, { tenantId: a, vertical: 'auth', binding: 'AUDIT_DB' });
    expect(authDb.ref).not.toBe(auditDb.ref);
  });

  it('fails closed for an unknown tenant', async () => {
    const { host, staff } = await world();
    await expect(
      host.provisionTenantStore(staff, {
        tenantId: tenantId.parse(ulid()),
        vertical: 'auth',
        binding: 'AUTH_DB',
      }),
    ).rejects.toThrow(/unknown tenant/);
  });

  it('refuses a ref that could escape the data directory (parse, don’t trust)', async () => {
    const { host } = await world();
    expect(() => host.openTenantStore({ binding: 'AUTH_DB', kind: 'relational', ref: '../evil.sqlite' })).toThrow(
      /invalid tenant-store ref/,
    );
  });
});
