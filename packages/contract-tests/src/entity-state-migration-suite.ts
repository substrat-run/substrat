/**
 * Contract suite for an authored migration that rebuilds a table the kernel derived onto (#2090).
 *
 * SQLite's create-copy-rename rebuild drops a table's triggers and indexes with it. On a table
 * that declares archive or trash, those are the kernel's guard triggers and its partial list
 * indexes — and the migrations that made them are journaled, so they never run again. A
 * migration runs on the scope's own handle, so `ctx.sql`'s after-DDL check never sees it
 * either. What this suite holds the migration pass to:
 *
 * - the derived objects come back, and the guard holds after them;
 * - a migration that takes a STATE column away fails the scope closed, rolled back, with the
 *   rows keeping their state — a column cannot be re-derived without inventing what it held;
 * - a rebuild split over two migrations still copies its binned rows, so the guard comes back
 *   only after the last migration of the pass;
 * - a rebuilt searchable table gets its search triggers back and its index rebuilt, so text
 *   rewritten or deleted afterwards — what subject erasure does — leaves the index;
 * - an authored rebuild of a table that declares no state runs as it always did.
 *
 * Each case provisions a scope of its own. Most make it forget ONE rebuild and run the pass
 * again: what a redeploy that added that rebuild to a live scope does. The rest change the
 * schema by hand with every migration journaled — a scope stripped before the pass checked, or
 * left with a derived object that has the right name and the wrong definition — and run
 * `migrateScope`, which repairs with nothing pending.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { permissionKey, platformActorId, principalId, scopeId, tenantId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { rebuildMod } from './entity-state-module.js';

type Row = Record<string, unknown>;

/** The adapter's way past `ctx.sql` and into its migration bookkeeping. */
export interface RawScopeAccess {
  /** One statement on the scope's own database; a SELECT's rows. */
  sql(tenant: TenantId, scope: ScopeId, sql: string): Promise<Row[]>;
  /**
   * Take `moduleId@version` out of the scope's journal AND out of whatever the host remembers of
   * it, so the next pass runs that migration again.
   */
  forget(tenant: TenantId, scope: ScopeId, moduleId: string, version: string): Promise<void>;
}

const MODULE = '@test/rebuild';
const STATEFUL = new Set(['rbnote', 'rbcut', 'rbsplit']);

export function entityStateMigrationContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
  raw: RawScopeAccess,
): void {
  describe(`an authored migration rebuilding a table the kernel derived onto (#2090): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const keeper = principalId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(rebuildMod);
      await host.admin.createTenant(staff, { id: t, slug: `rebuild-${t.toLowerCase()}`, name: 'Rebuild' });
      await host.admin.grantEntitlement(staff, t, 'rebuild');
      await host.admin.defineRole(staff, t, {
        key: 'rb-keeper',
        permissions: ['rb:use', 'rb:archive', 'rb:trash'].map((k) => permissionKey.parse(k)),
        source: 'vertical',
      });
      await host.admin.assignRole(staff, { principalId: keeper, roleKey: 'rb-keeper', node: { tenantId: t, scopeId: null } });
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    const freshScope = async () => {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'rebuild-vertical' });
      await host.admin.activateScope(staff, t, s);
      return { s, stub: await host.getScope(keeper, t, s) };
    };
    /** A provisioned scope holding one active and one binned row of `entityType`. */
    const scopeWith = async (entityType: string) => {
      const { s, stub } = await freshScope();
      const kept = ulid();
      const binned = ulid();
      await stub.invoke('rb/add', { entityType, id: kept, title: 'kept' });
      await stub.invoke('rb/add', { entityType, id: binned, title: 'binned' });
      if (STATEFUL.has(entityType)) await stub.invoke('rb/trash', { entityType, id: binned });
      return { s, stub, kept, binned };
    };
    const objectsOn = async (s: ScopeId, table: string) =>
      (await raw.sql(t, s, `SELECT name FROM sqlite_master WHERE tbl_name = '${table}' AND name LIKE '\\_substrat\\_%' ESCAPE '\\' ORDER BY name`)).map(
        (r) => String(r['name']),
      );
    const columnsOf = async (s: ScopeId, table: string) =>
      (await raw.sql(t, s, `SELECT name FROM pragma_table_info('${table}')`)).map((r) => String(r['name']));
    /** Every kernel-prefixed object in the scope, name → its CREATE statement. */
    const definitions = async (s: ScopeId) =>
      Object.fromEntries(
        (await raw.sql(t, s, `SELECT name, sql FROM sqlite_master WHERE name LIKE '\\_substrat\\_%' ESCAPE '\\' AND sql IS NOT NULL`))
          .filter((r) => /^_substrat_(state|list|search)_/.test(String(r['name'])))
          .map((r) => [String(r['name']), String(r['sql'])]),
      );
    /** Statements on the scope's own handle, one at a time — past `ctx.sql`, the journal untouched. */
    const rawAll = async (s: ScopeId, statements: string[]) => {
      for (const statement of statements) await raw.sql(t, s, statement);
    };
    /** A rebuilt-by-hand table, as a migration journaled before #2090 would have left it. */
    const rebuild = (table: string, select = '*') => [
      `CREATE TABLE ${table}_new AS SELECT ${select} FROM ${table}`,
      `DROP TABLE ${table}`,
      `ALTER TABLE ${table}_new RENAME TO ${table}`,
    ];

    it('puts back the guard triggers and list indexes a rebuild dropped, and the guard holds after it', async () => {
      const { s, stub, binned } = await scopeWith('rbnote');
      const derived = await objectsOn(s, 'rb_notes');
      expect(derived).toEqual([
        '_substrat_list_test_rebuild_rbnote_title',
        '_substrat_list_test_rebuild_rbnote_title_archived',
        '_substrat_list_test_rebuild_rbnote_title_trashed',
        '_substrat_state_rb_notes_born',
        '_substrat_state_rb_notes_moved',
      ]);

      await raw.forget(t, s, MODULE, '0002-rebuild-notes');
      expect(await host.migrateScope(t, s)).toMatchObject({ status: 'migrated' });

      expect(await objectsOn(s, 'rb_notes')).toEqual(derived);
      // The guard, past `ctx.sql`: a row moves only through a kernel verb, and is never born binned.
      await expect(raw.sql(t, s, `UPDATE rb_notes SET _substrat_trashed_at = NULL WHERE id = '${binned}'`)).rejects.toThrow(
        /moves only through ctx\.archive/,
      );
      await expect(
        raw.sql(t, s, `INSERT INTO rb_notes (id, title, _substrat_archived_at) VALUES ('${ulid()}', 'x', '2026')`),
      ).rejects.toThrow(/never inserted archived or trashed/);
      // The rows kept their state through the rebuild, and the kernel's own move still passes.
      expect(await stub.invoke('rb/state', { entityType: 'rbnote', id: binned })).toBe('trashed');
      await stub.invoke('rb/restore', { entityType: 'rbnote', id: binned });
      expect(await stub.invoke('rb/state', { entityType: 'rbnote', id: binned })).toBe('active');
    });

    it('fails the scope closed when a migration drops a state column — rolled back, every row keeping its state', async () => {
      const { s, binned } = await scopeWith('rbcut');
      const before = await objectsOn(s, 'rb_cut');

      // Not the last of its pass, so nothing after it gets the chance to cover for it.
      await raw.forget(t, s, MODULE, '0003-rebuild-cut');
      await raw.forget(t, s, MODULE, '0004-rebuild-plain');
      const outcome = await host.migrateScope(t, s);
      expect(outcome).toMatchObject({ status: 'failed', failure: { version: `${MODULE}@0003-rebuild-cut` } });
      expect(outcome.status === 'failed' && outcome.failure.error).toMatch(
        /migration @test\/rebuild@0003-rebuild-cut left 'rb_cut' without _substrat_trashed_at/,
      );
      expect((await host.admin.getScopeRecord(staff, t, s))?.migrationFailure?.version).toBe(`${MODULE}@0003-rebuild-cut`);

      // Nothing is served, and a second pass fails the same way: it is the migration, not a moment.
      await expect(
        host.getScope(keeper, t, s).then((stub) => stub.invoke('rb/state', { entityType: 'rbcut', id: binned })),
      ).rejects.toThrow(/without _substrat_trashed_at/);
      expect(await host.migrateScope(t, s)).toMatchObject({ status: 'failed' });

      // Rolled back: the column, the binned row in it, and the guard are all where they were.
      expect(await columnsOf(s, 'rb_cut')).toContain('_substrat_trashed_at');
      expect(await raw.sql(t, s, `SELECT _substrat_trashed_at IS NOT NULL AS binned FROM rb_cut WHERE id = '${binned}'`)).toEqual([
        { binned: 1 },
      ]);
      expect(await objectsOn(s, 'rb_cut')).toEqual(before);
    });

    it('lets a rebuild split over two migrations copy its binned rows, and puts the guard back after the last', async () => {
      const { s, stub, binned } = await scopeWith('rbsplit');
      const before = await objectsOn(s, 'rb_split');

      // A guard put back between the two would refuse the binned row the second one copies.
      await raw.forget(t, s, MODULE, '0005-split-aside');
      await raw.forget(t, s, MODULE, '0006-split-copy');
      expect(await host.migrateScope(t, s)).toMatchObject({ status: 'migrated' });

      expect(await objectsOn(s, 'rb_split')).toEqual(before);
      expect(await stub.invoke('rb/state', { entityType: 'rbsplit', id: binned })).toBe('trashed');
      await expect(raw.sql(t, s, `UPDATE rb_split SET _substrat_trashed_at = NULL WHERE id = '${binned}'`)).rejects.toThrow(
        /moves only through ctx\.archive/,
      );
    });

    it('rebuilds a searchable table’s index and its triggers, so rewritten or deleted text leaves search', async () => {
      const { s, stub } = await freshScope();
      const [rewritten, deleted, untouched] = [ulid(), ulid(), ulid()];
      await stub.invoke('rb/add', { entityType: 'rbsearch', id: rewritten, title: 'alpha secret' });
      await stub.invoke('rb/add', { entityType: 'rbsearch', id: deleted, title: 'beta private' });
      await stub.invoke('rb/add', { entityType: 'rbsearch', id: untouched, title: 'delta plain' });
      const before = await objectsOn(s, 'rb_search');
      expect(before).toEqual(['ad', 'ai', 'au'].map((s) => `_substrat_search_test_rebuild_rbsearch_${s}`));

      // The rebuild copies the rows in reverse, so every rowid the old index points at moves.
      await raw.forget(t, s, MODULE, '0007-rebuild-search');
      expect(await host.migrateScope(t, s)).toMatchObject({ status: 'migrated' });
      expect(await objectsOn(s, 'rb_search')).toEqual(before);
      expect(await stub.invoke('rb/search', { term: 'alpha' })).toEqual([rewritten]);
      expect(await stub.invoke('rb/search', { term: 'delta' })).toEqual([untouched]);

      // Erasure's two shapes: the text rewritten in place, and the row removed.
      await stub.invoke('rb/retitle', { id: rewritten, title: 'gamma redacted' });
      await stub.invoke('rb/remove', { id: deleted });
      expect(await stub.invoke('rb/search', { term: 'secret' })).toEqual([]);
      expect(await stub.invoke('rb/search', { term: 'private' })).toEqual([]);
      expect(await stub.invoke('rb/search', { term: 'gamma' })).toEqual([rewritten]);
    });

    // -- scopes already stripped, every migration journaled (Codex r1 on #2091) -----------------

    it('repairs a scope a journaled rebuild already stripped — with nothing pending, on the next pass', async () => {
      const { s, stub, binned } = await scopeWith('rbnote');
      const said = ulid();
      await stub.invoke('rb/add', { entityType: 'rbsearch', id: said, title: 'alpha secret' });
      const before = await definitions(s);
      await rawAll(s, [...rebuild('rb_notes'), ...rebuild('rb_search')]);
      expect(Object.keys(await definitions(s))).not.toContain('_substrat_state_rb_notes_born');

      expect(await host.migrateScope(t, s)).toMatchObject({ status: 'noop' });
      expect(await definitions(s)).toEqual(before);
      await expect(raw.sql(t, s, `UPDATE rb_notes SET _substrat_trashed_at = NULL WHERE id = '${binned}'`)).rejects.toThrow(
        /moves only through ctx\.archive/,
      );
      await stub.invoke('rb/retitle', { id: said, title: 'gamma redacted' });
      expect(await stub.invoke('rb/search', { term: 'secret' })).toEqual([]);
      expect(await stub.invoke('rb/search', { term: 'gamma' })).toEqual([said]);
    });

    it('re-creates a derived object present by name but not as the kernel defines it', async () => {
      const { s, stub, binned } = await scopeWith('rbnote');
      const said = ulid();
      await stub.invoke('rb/add', { entityType: 'rbsearch', id: said, title: 'alpha secret' });
      const before = await definitions(s);
      await rawAll(s, [
        // A search update trigger that keeps nothing in step: erased text would stay found.
        'DROP TRIGGER _substrat_search_test_rebuild_rbsearch_au',
        'CREATE TRIGGER _substrat_search_test_rebuild_rbsearch_au AFTER UPDATE ON rb_search BEGIN SELECT 1; END',
        // A guard that never fires.
        'DROP TRIGGER _substrat_state_rb_notes_moved',
        'CREATE TRIGGER _substrat_state_rb_notes_moved BEFORE UPDATE OF _substrat_trashed_at ON rb_notes WHEN 0 BEGIN SELECT 1; END',
        // A list index on the wrong columns, and one with the wrong partial predicate.
        'DROP INDEX _substrat_list_test_rebuild_rbnote_title',
        'CREATE INDEX _substrat_list_test_rebuild_rbnote_title ON rb_notes (id)',
        'DROP INDEX _substrat_list_test_rebuild_rbnote_title_archived',
        'CREATE INDEX _substrat_list_test_rebuild_rbnote_title_archived ON rb_notes (title, id) WHERE _substrat_archived_at IS NULL',
      ]);
      expect(await definitions(s)).not.toEqual(before);

      expect(await host.migrateScope(t, s)).toMatchObject({ status: 'noop' });
      expect(await definitions(s)).toEqual(before);
      await expect(raw.sql(t, s, `UPDATE rb_notes SET _substrat_trashed_at = NULL WHERE id = '${binned}'`)).rejects.toThrow(
        /moves only through ctx\.archive/,
      );
      await stub.invoke('rb/retitle', { id: said, title: 'gamma redacted' });
      expect(await stub.invoke('rb/search', { term: 'secret' })).toEqual([]);
    });

    it('fails closed on the next pass when a journaled state column is already gone — nothing is served', async () => {
      const { s, binned } = await scopeWith('rbcut');
      await rawAll(s, rebuild('rb_cut', 'id, title'));

      const outcome = await host.migrateScope(t, s);
      expect(outcome).toMatchObject({ status: 'failed', failure: { version: `${MODULE}@state/rbcut:trash` } });
      expect(outcome.status === 'failed' && outcome.failure.error).toMatch(
        /an applied migration left 'rb_cut' without _substrat_trashed_at/,
      );
      await expect(
        host.getScope(keeper, t, s).then((stub) => stub.invoke('rb/state', { entityType: 'rbcut', id: binned })),
      ).rejects.toThrow(/without _substrat_trashed_at/);
    });

    it('refuses a restore whose journal owes a table a state column the dump does not carry — the load rolls back whole', async () => {
      const { s, stub, binned } = await scopeWith('rbcut');
      const before = await definitions(s);
      const dump = await host.admin.exportScope(staff, t, s);
      const malformed = {
        ...dump,
        tables: dump.tables.map((table) => {
          if (table.name !== 'rb_cut') return table;
          const keep = table.columns.map((c, i) => (c === '_substrat_trashed_at' ? -1 : i)).filter((i) => i >= 0);
          return {
            ...table,
            ddl: `CREATE TABLE rb_cut (${keep.map((i) => `${table.columns[i]} TEXT`).join(', ')})`,
            columns: keep.map((i) => table.columns[i]!),
            rows: table.rows.map((row) => keep.map((i) => row[i])),
          };
        }),
      };
      await expect(host.restoreScope(staff, t, s, malformed)).rejects.toThrow(
        /the restored dump left 'rb_cut' without _substrat_trashed_at/,
      );
      // Nothing of the load committed: the column, the binned row and the guard are all as they were.
      expect(await columnsOf(s, 'rb_cut')).toContain('_substrat_trashed_at');
      expect(await definitions(s)).toEqual(before);
      expect(await stub.invoke('rb/state', { entityType: 'rbcut', id: binned })).toBe('trashed');
      // The twin: the same dump, unaltered, restores.
      await host.restoreScope(staff, t, s, dump);
      expect(await stub.invoke('rb/state', { entityType: 'rbcut', id: binned })).toBe('trashed');
    });

    it('repairs a search-only table a module rebuilt through ctx.sql, before its operation commits (Codex r2 on #2091)', async () => {
      const { s, stub } = await freshScope();
      const said = ulid();
      await stub.invoke('rb/add', { entityType: 'rbsearch', id: said, title: 'alpha secret' });
      const before = await definitions(s);
      // Supported runtime DDL: `rb_search` declares no state, so no text guard stands in the way.
      await stub.invoke('rb/ddl', { statements: rebuild('rb_search') });
      expect(await definitions(s)).toEqual(before);
      await stub.invoke('rb/retitle', { id: said, title: 'gamma redacted' });
      expect(await stub.invoke('rb/search', { term: 'secret' })).toEqual([]);
      expect(await stub.invoke('rb/search', { term: 'gamma' })).toEqual([said]);
      await stub.invoke('rb/remove', { id: said });
      expect(await stub.invoke('rb/search', { term: 'gamma' })).toEqual([]);
    });

    it('repairs between the statements of ONE ctx.sql call — a rebuild, a write and a read of the index see no stale hit (Codex r3)', async () => {
      const { s, stub } = await freshScope();
      const said = ulid();
      await stub.invoke('rb/add', { entityType: 'rbsearch', id: said, title: 'alpha secret' });
      const idx = '_substrat_search_test_rebuild_rbsearch';
      const rows = await stub.invoke<{ n: number }[]>('rb/batch', {
        sql: [
          ...rebuild('rb_search'),
          `UPDATE rb_search SET title = 'gamma redacted' WHERE id = '${said}'`,
          `SELECT COUNT(*) AS n FROM ${idx} WHERE ${idx} MATCH 'secret'`,
        ].join(';\n'),
      });
      expect(rows).toEqual([{ n: 0 }]);
      expect(await stub.invoke('rb/search', { term: 'gamma' })).toEqual([said]);
    });

    it('refuses a multi-statement schema change that binds parameters, and runs none of it', async () => {
      const { s, stub } = await freshScope();
      const before = await definitions(s);
      await expect(stub.invoke('rb/ddl-bound', {})).rejects.toThrow(/binds parameters runs one statement/);
      expect(await columnsOf(s, 'rb_plain')).toEqual(['id', 'title']);
      expect(await definitions(s)).toEqual(before);
    });

    it('runs no DDL over a scope that already carries everything as the kernel emits it', async () => {
      const { s } = await scopeWith('rbnote');
      await host.migrateScope(t, s);
      // A re-created object is a new `sqlite_master` row: the rowids are what a DROP-and-CREATE
      // moves. (A Durable Object refuses `pragma_schema_version`.)
      const catalogue = async () => raw.sql(t, s, 'SELECT rowid, name FROM sqlite_master ORDER BY rowid');
      const before = await catalogue();
      expect(await host.migrateScope(t, s)).toMatchObject({ status: 'noop' });
      expect(await catalogue()).toEqual(before);
    });

    it('twin: a rebuild of a table that declares no state runs as before, and its list index comes back too', async () => {
      const { s, stub } = await scopeWith('rbplain');
      const before = await objectsOn(s, 'rb_plain');
      expect(before).toEqual(['_substrat_list_test_rebuild_rbplain_title']);

      await raw.forget(t, s, MODULE, '0004-rebuild-plain');
      expect(await host.migrateScope(t, s)).toMatchObject({ status: 'migrated' });

      expect(await stub.invoke('rb/titles', { entityType: 'rbplain' })).toEqual(['binned', 'kept']);
      expect(await objectsOn(s, 'rb_plain')).toEqual(before);
    });
  });
}
