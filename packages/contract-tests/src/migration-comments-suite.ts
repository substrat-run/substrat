/**
 * Contract suite for comments in a module's migration DDL (#2068, Codex #2084 r5): a commented
 * `CREATE TABLE`, then a later migration dropping its LAST column, must migrate on every adapter
 * — a failed migration closes the scope. And `--` / `/*` inside string literals are data: the
 * row and the column default carry them intact. The fixture is `commentedDdlMod`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { splitSqlStatements, ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { commentedDdlMod } from './migration-comments.js';

export function migrationCommentsContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  describe(`comments in migration DDL (#2068): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(commentedDdlMod);
      await host.admin.createTenant(staff, { id: t, slug: `cm-${t.toLowerCase()}`, name: 'Comments' });
      await host.admin.grantEntitlement(staff, t, 'commented-ddl');
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'commented-ddl' });
      await host.admin.activateScope(staff, t, s);
    });
    afterAll(async () => {
      await fixture.cleanup();
    });

    it('drops the last column of a table whose DDL was commented, and keeps literals that look like comments', async () => {
      const stub = await host.getScope(principalId.parse(ulid()), t, s);
      const read = await stub.invoke<{ columns: string[]; noteDefault: string; rows: unknown[]; stored: string }>(
        'commented-ddl/read',
        undefined,
      );
      // 0002 ran: the last column is gone, and the scope is open.
      expect(read.columns).toEqual(['id', 'note']);
      // The twin: `--` and `/*` inside strings are data, in the row and in the default alike.
      expect(read.rows).toEqual([{ id: 'r1', note: 'keep -- this; and /* that */ too' }]);
      expect(read.noteDefault).toBe("'-- not a comment; /* nor this */'");
      // The stored DDL carries no comment text — what was executed was the blanked statement.
      expect(read.stored).not.toMatch(/one row per run|free text|came back/);
      expect(read.stored).toContain("'-- not a comment; /* nor this */'");
    });

    /**
     * Codex #2084 r6: a dump records `sqlite_master.sql` verbatim, comments included, and a restore
     * replays it. A scope restored from a dump whose module table was created commented — as a
     * pre-fix scope, or any SQLite host, stores it — must still take a later migration dropping
     * that table's last column. The dump is a real export, edited to what such a scope holds: the
     * original commented CREATE TABLE, a row from before the drop, and a journal at 0001 only.
     */
    const commentedDump = async () => {
      const dump = await host.admin.exportScope(staff, t, s);
      const authored = splitSqlStatements(commentedDdlMod.migrations![0]!.sql)[0]!;
      const create = authored.slice(authored.indexOf('CREATE TABLE'));
      const tables = dump.tables.map((table) => {
        if (table.name === 'cm_runs') {
          return { ...table, ddl: create, columns: ['id', 'note', 'finished_at'], rows: [['r1', 'keep -- this; and /* that */ too', null]] };
        }
        if (table.name === '_substrat_migrations') {
          const m = table.columns.indexOf('module_id');
          const v = table.columns.indexOf('version');
          return { ...table, rows: table.rows.filter((r) => !(r[m] === '@test/commented-ddl' && r[v] === '0002-drop-last')) };
        }
        return table;
      });
      expect(tables.find((x) => x.name === 'cm_runs')?.ddl).toMatch(/-- one row per run/);
      return { ...dump, tables };
    };
    const readBack = async (scope: typeof s) => {
      const stub = await host.getScope(principalId.parse(ulid()), t, scope);
      return stub.invoke<{ columns: string[]; noteDefault: string; rows: unknown[]; stored: string }>('commented-ddl/read', undefined);
    };

    it('a fork from a dump with a commented CREATE TABLE takes the migration that drops its last column', async () => {
      const fork = scopeId.parse(ulid());
      await host.importScope(staff, { tenantId: t, scopeId: fork, vertical: 'commented-ddl' }, await commentedDump());
      const read = await readBack(fork);
      expect(read.columns).toEqual(['id', 'note']);
      expect(read.rows).toEqual([{ id: 'r1', note: 'keep -- this; and /* that */ too' }]);
      expect(read.noteDefault).toBe("'-- not a comment; /* nor this */'");
      expect(read.stored).not.toMatch(/one row per run|free text|came back/);
    });

    it('a restore in place does the same', async () => {
      const target = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: target, vertical: 'commented-ddl' });
      await host.admin.activateScope(staff, t, target);
      await host.restoreScope(staff, t, target, await commentedDump());
      const read = await readBack(target);
      expect(read.columns).toEqual(['id', 'note']);
      expect(read.rows).toEqual([{ id: 'r1', note: 'keep -- this; and /* that */ too' }]);
      expect(read.stored).not.toMatch(/one row per run|free text|came back/);
    });
  });
}
