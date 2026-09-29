import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, UNSAFE_allowAllChecker, type ModuleRegistration } from '@substrat-run/kernel';
import { ownParentMod, spineParentMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #1898 on the pure adapter: nothing a vertical brings may make a spine table the parent of
 * its rows. With foreign keys enforced, the kernel's own writes to that table (a revoke, a
 * restore's re-point, an outbox prune) would then fail on the vertical's rows. A scope
 * restore's replayed DDL is refused by `assertReplayableDump`; a migration, which runs on the
 * scope's own handle rather than `ctx.sql`, by `assertNoSpineReference`.
 */
const staff = platformActorId.parse('01JZ00000000000000000000ST');

describe('a foreign key to the spine (#1898), on the pure adapter', () => {
  let dir: string | undefined;
  let host: SqliteScopeHost | undefined;
  afterEach(async () => {
    await host?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = host = undefined;
  });

  const provision = async (mod: ModuleRegistration) => {
    dir = mkdtempSync(join(tmpdir(), 'spine-references-'));
    host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
    host.registerModule(mod);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await host.admin.grantEntitlement(staff, t, 'notes');
    return { h: host, t, s, provisioned: host.provisionScope(staff, { tenantId: t, scopeId: s, jurisdiction: 'eu' }) };
  };

  describe('in a migration', () => {
    it('is refused, and the scope fails closed with none of that migration applied', async () => {
      const { h, t, s, provisioned } = await provision(spineParentMod);
      await expect(provisioned).rejects.toThrow(/migration @test\/spine-parent@0001-init cannot declare a foreign key to the platform spine/);
      const record = await h.admin.getScopeRecord(staff, t, s);
      expect(record?.migrationFailure?.version).toBe('@test/spine-parent@0001-init');
      const tables = (await h.admin.listScopeTables(staff, t, s)).map((x) => x.name);
      expect(tables).not.toContain('lists');
      expect(tables).not.toContain('notes');
    });

    it('twin: a foreign key to the module’s own table applies', async () => {
      const { h, t, s, provisioned } = await provision(ownParentMod);
      await provisioned;
      const tables = (await h.admin.listScopeTables(staff, t, s)).map((x) => x.name);
      expect(tables).toEqual(expect.arrayContaining(['lists', 'notes']));
    });
  });

  describe('in a scope restore’s replayed DDL', () => {
    it('is refused, and the scope keeps every table and row it held', async () => {
      const { h, t, s, provisioned } = await provision(ownParentMod);
      await provisioned;
      const before = await h.admin.exportScope(staff, t, s);
      const crafted = {
        ...before,
        tables: before.tables.map((x) =>
          x.name === 'notes' ? { ...x, ddl: 'CREATE TABLE notes (t TEXT REFERENCES _substrat_tuples(subject))' } : x,
        ),
      };
      await expect(h.restoreScope(staff, t, s, crafted)).rejects.toThrow(/foreign key to the platform spine/);
      expect((await h.admin.exportScope(staff, t, s)).tables).toEqual(before.tables);
    });

    it('twin: the same dump with its own foreign key restores', async () => {
      const { h, t, s, provisioned } = await provision(ownParentMod);
      await provisioned;
      const before = await h.admin.exportScope(staff, t, s);
      await h.restoreScope(staff, t, s, before);
      expect((await h.admin.exportScope(staff, t, s)).tables.find((x) => x.name === 'notes')?.ddl).toBe(
        'CREATE TABLE notes (t TEXT REFERENCES lists(id))',
      );
    });
  });
});
