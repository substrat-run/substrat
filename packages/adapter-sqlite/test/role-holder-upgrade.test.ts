import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { moduleManifest, permissionKey, platformActorId, principalId, scopeId, tenantId, type PermissionKey } from '@substrat-run/contracts';
import { reservedRoleRefusal, ulid, type ModuleRegistration } from '@substrat-run/kernel';
import { permMod, testOperations } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

it('adds the directory holder column without rewriting an old role, then persists its new definition', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'role-holder-upgrade-'));
  const staff = platformActorId.parse(ulid());
  const tenant = tenantId.parse(ulid());
  const definition = { key: 'runner', permissions: [permissionKey.parse('rsv:run')], source: 'vertical' as const };
  try {
    const before = new SqliteScopeHost({ dir });
    await before.admin.createTenant(staff, { id: tenant, slug: 'acme', name: 'Acme' });
    await before.admin.defineRole(staff, tenant, definition);
    await before.close();

    const db = new Database(join(dir, '_directory.sqlite'));
    db.exec('ALTER TABLE _substrat_roles DROP COLUMN holder'); // storage from before #2444
    expect(db.prepare('SELECT role_key, permissions FROM _substrat_roles').get()).toEqual({ role_key: 'runner', permissions: '["rsv:run"]' });
    db.close();

    const after = new SqliteScopeHost({ dir });
    try {
      const oldRole = (await after.admin.listRoles(staff, { tenantId: tenant }))[0]!;
      expect(oldRole.holder).toBeUndefined();
      expect(reservedRoleRefusal(oldRole, new Set(['rsv:run']), 'platform')).toBeNull();
      await after.admin.defineRole(staff, tenant, { ...definition, holder: 'system' });
      expect((await after.admin.listRoles(staff, { tenantId: tenant }))[0]?.holder).toBe('system');
    } finally {
      await after.close();
    }
    const persisted = new SqliteScopeHost({ dir });
    try {
      expect((await persisted.admin.listRoles(staff, { tenantId: tenant }))[0]?.holder).toBe('system');
    } finally {
      await persisted.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2447 review round 3: the seats decide a holder-less legacy row as well. An upgrade admitted
// beside a person's seat let a later system-held definition add a key to that seat in two releases
// ([a] holder: system, then [a, b]) that the one-step definition refused.
it('refuses making a seated legacy holder-less role system-held, in one release or two; an unseated one upgrades', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-holder-seat-'));
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const bob = principalId.parse(ulid());
  const A = 'two:a' as PermissionKey;
  const B = 'two:b' as PermissionKey;
  const twoMod: ModuleRegistration = {
    manifest: moduleManifest.parse({
      id: '@test/two',
      version: '1.0.0',
      kernelContract: '^0.0.1',
      permissions: [
        { key: A, description: 'a', holder: 'system' },
        { key: B, description: 'b', holder: 'system' },
      ],
      events: { emits: [], consumes: [] },
      migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
      attachmentTargets: [],
      entitlementKey: 'two',
    }),
    migrations: [],
    ...testOperations({}),
  };
  try {
    const before = new SqliteScopeHost({ dir });
    before.registerModule(permMod);
    await before.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    await before.admin.grantEntitlement(staff, t, 'perm');
    await before.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'v' });
    await before.admin.activateScope(staff, t, s);
    for (const key of ['ops', 'idle']) await before.admin.defineRole(staff, t, { key, permissions: [A], source: 'vertical' });
    await before.admin.assignRole(staff, { principalId: bob, roleKey: 'ops', node: { tenantId: t, scopeId: s } });
    await before.close();

    const db = new Database(join(dir, '_directory.sqlite'));
    db.prepare('UPDATE _substrat_roles SET holder = NULL').run(); // rows from before #2444
    db.close();

    const after = new SqliteScopeHost({ dir });
    try {
      after.registerModule(permMod);
      after.registerModule(twoMod);
      const holds = async (p: PermissionKey) =>
        (await (await after.getScope(bob, t, s)).invoke<{ allowed: boolean }>('perm/probe', { permission: p })).allowed;
      const role = async (key: string) => (await after.admin.listRoles(staff, { tenantId: t })).find((r) => r.key === key);
      // One release, the keys widened: refused.
      await expect(after.admin.defineRole(staff, t, { key: 'ops', permissions: [A, B], source: 'vertical', holder: 'system' })).rejects.toThrow(
        /cannot be declared holder: 'system'/,
      );
      // The first of two releases, the same keys: refused as well, so the second never meets a system-held row.
      await expect(after.admin.defineRole(staff, t, { key: 'ops', permissions: [A], source: 'vertical', holder: 'system' })).rejects.toThrow(
        /cannot be declared holder: 'system'/,
      );
      expect((await role('ops'))?.holder).toBeUndefined();
      expect(await holds(B)).toBe(false);
      // The twin: a legacy row nobody holds upgrades (#2480).
      await after.admin.defineRole(staff, t, { key: 'idle', permissions: [A], source: 'vertical', holder: 'system' });
      expect(await role('idle')).toMatchObject({ permissions: [A], holder: 'system' });
    } finally {
      await after.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
