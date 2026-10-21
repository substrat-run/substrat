import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { platformActorId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

it('adds the directory holder column without rewriting an old role, then persists its new definition', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'role-holder-upgrade-'));
  const staff = platformActorId.parse(ulid());
  const tenant = tenantId.parse(ulid());
  const definition = { key: 'runner', permissions: ['rsv:run'], source: 'vertical' as const };
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
      expect((await after.admin.listRoles(staff, { tenantId: tenant }))[0]?.holder).toBeUndefined();
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
