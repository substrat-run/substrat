/**
 * Declaring archive/trash on an entity that already has rows (#119) — the upgrade every
 * adopter takes, since no entity starts life archivable.
 *
 * A new host over the same directory is a redeploy (as `migration-failure.test.ts` uses it):
 * the derived migrations add the two columns, rebuild the list indexes as partial ones, and
 * every row that existed before comes out ACTIVE — a NULL in both columns, with no backfill.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { moduleManifest, permissionKey, platformActorId, principalId, scopeId, tenantId, type Page } from '@substrat-run/contracts';
import {
  moduleMigrations,
  ulid,
  type ModuleRegistration,
  type OperationHandler,
} from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

const MODULE = '@test/upgrade-state';

const manifestOf = (withStates: boolean) =>
  moduleManifest.parse({
    id: MODULE,
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [
      { key: 'up:use', description: 'use it' },
      { key: 'up:archive', description: 'archive it' },
      { key: 'up:trash', description: 'bin it' },
    ],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'upgrade',
    lists: [{ entityType: 'upnote', sortable: ['created_at', 'id'], table: 'up_notes', idColumn: 'id' }],
    ...(withStates
      ? {
          entityStates: [
            { entityType: 'upnote', archivePermission: 'up:archive', trashPermission: 'up:trash', table: 'up_notes', idColumn: 'id' },
          ],
        }
      : {}),
  });

const modOf = (withStates: boolean): ModuleRegistration => ({
  manifest: manifestOf(withStates),
  migrations: [{ version: '0001-init', sql: 'CREATE TABLE up_notes (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);' }],
  operations: {
    'up/add': (async (ctx, input) => {
      const id = (input as { id: string }).id;
      ctx.sql.exec('INSERT INTO up_notes (id, created_at) VALUES (?, ?)', [id, ctx.now()]);
      return { id };
    }) as OperationHandler<never, unknown>,
    'up/page': (async (ctx) => ctx.page('upnote', { limit: 50 })) as OperationHandler<never, unknown>,
    'up/archive': (async (ctx, input) => {
      await ctx.archive({ entityType: 'upnote', entityId: (input as { id: string }).id });
      return null;
    }) as OperationHandler<never, unknown>,
  },
});

describe('declaring archive/trash on an entity with rows (#119)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-state-upgrade-'));
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const who = principalId.parse(ulid());
  const before = ['01A', '01B', '01C'];
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('adds the columns, makes the list indexes partial, and leaves every existing row active', async () => {
    const v1 = new SqliteScopeHost({ dir });
    v1.registerModule(modOf(false));
    await v1.admin.createTenant(staff, { id: t, slug: `up-${ulid().toLowerCase()}`, name: 'Up' });
    await v1.admin.grantEntitlement(staff, t, 'upgrade');
    await v1.admin.defineRole(staff, t, {
      key: 'up-keeper',
      permissions: ['up:use', 'up:archive', 'up:trash'].map((k) => permissionKey.parse(k)),
      source: 'vertical',
    });
    await v1.admin.assignRole(staff, { principalId: who, roleKey: 'up-keeper', node: { tenantId: t, scopeId: null } });
    await v1.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'upgrade' });
    await v1.admin.activateScope(staff, t, s);
    const old = await v1.getScope(who, t, s);
    for (const id of before) await old.invoke('up/add', { id });
    await v1.close();

    const v2 = new SqliteScopeHost({ dir });
    try {
      v2.registerModule(modOf(true));
      expect((await v2.migrateScope(t, s)).status).toBe('migrated');

      const applied = await v2.admin.queryScope(staff, t, s, {
        sql: `SELECT version FROM _substrat_migrations WHERE module_id = '${MODULE}' ORDER BY rowid`,
      });
      // The v1 list index stays applied; the columns, then the partial rebuild, follow it.
      expect(applied.rows.map((r) => r[0])).toEqual([
        '0001-init',
        'list/upnote:created_at+id:',
        'state/upnote:archive',
        'state/upnote:trash',
        'state/upnote:born:archive+trash',
        'list/upnote:created_at+id::active+archived+trashed',
      ]);
      expect(moduleMigrations(modOf(true)).map((m) => m.version)).toEqual([
        '0001-init',
        'state/upnote:archive',
        'state/upnote:trash',
        'state/upnote:born:archive+trash',
        'list/upnote:created_at+id::active+archived+trashed',
      ]);

      const indexes = await v2.admin.queryScope(staff, t, s, {
        sql: `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'up_notes' AND name LIKE '_substrat_list_%' ORDER BY name`,
      });
      expect(indexes.rows.map((r) => r[0])).toEqual([
        '_substrat_list_test_upgrade_state_upnote_created_at',
        '_substrat_list_test_upgrade_state_upnote_created_at_archived',
        '_substrat_list_test_upgrade_state_upnote_created_at_trashed',
        '_substrat_list_test_upgrade_state_upnote_id',
        '_substrat_list_test_upgrade_state_upnote_id_archived',
        '_substrat_list_test_upgrade_state_upnote_id_trashed',
      ]);
      expect(indexes.rows.every((r) => / WHERE _substrat_/.test(String(r[1])))).toBe(true);

      const stub = await v2.getScope(who, t, s);
      const ids = async () => (await stub.invoke<Page<{ id: string }>>('up/page', {})).entries.map((r) => r.id);
      expect(await ids()).toEqual(before);
      await stub.invoke('up/archive', { id: '01B' });
      expect(await ids()).toEqual(['01A', '01C']);
    } finally {
      await v2.close();
    }
  });
});
