/**
 * The fixture behind `entityStateContractSuite` (#119): a module whose entities differ in
 * exactly what they declare.
 *
 * - `stdoc` — archive AND trash, each with its own key; paged, filterable and searchable.
 * - `stnote` — archive only, so the suite can see a trash refused on it and a one-column
 *   partial index.
 * - `stplain` — neither, so the verbs and the views are refused on it rather than guessed at.
 *
 * Every operation is a thin pass-through to the verb or read under test, and checks nothing
 * itself: the KERNEL's check of the declared key is what the suite is asserting on.
 */
import { moduleManifest, type EntityRef } from '@substrat-run/contracts';
import {
  listIndexPlans,
  listQuery,
  readHistory,
  type ModuleRegistration,
  type OperationHandler,
} from '@substrat-run/kernel';

export const stateModManifest = moduleManifest.parse({
  id: '@test/state',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'doc:read', description: 'read the documents' },
    { key: 'doc:archive', description: 'archive a document or bring it back' },
    { key: 'doc:trash', description: 'bin a document or restore it' },
  ],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'state',
  searchables: [{ entityType: 'stdoc', fields: ['title'], table: 'state_docs', idColumn: 'id' }],
  lists: [
    { entityType: 'stdoc', sortable: ['title', 'id'], filterable: ['owner'], table: 'state_docs', idColumn: 'id' },
    { entityType: 'stnote', sortable: ['title'], table: 'state_notes', idColumn: 'id' },
    { entityType: 'stplain', sortable: ['title'], table: 'state_plain', idColumn: 'id' },
  ],
  entityStates: [
    {
      entityType: 'stdoc',
      archivePermission: 'doc:archive',
      trashPermission: 'doc:trash',
      table: 'state_docs',
      idColumn: 'id',
    },
    { entityType: 'stnote', archivePermission: 'doc:archive', table: 'state_notes', idColumn: 'id' },
  ],
});

type Handler = OperationHandler<never, unknown>;
const ref = (input: unknown): EntityRef => {
  const i = input as { entityType?: string; id: string };
  return { entityType: i.entityType ?? 'stdoc', entityId: i.id };
};

export const stateMod: ModuleRegistration = {
  manifest: stateModManifest,
  migrations: [
    {
      version: '0001-init',
      sql: `CREATE TABLE state_docs (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner TEXT NOT NULL);
            CREATE TABLE state_notes (id TEXT PRIMARY KEY, title TEXT NOT NULL);
            CREATE TABLE state_plain (id TEXT PRIMARY KEY, title TEXT NOT NULL);`,
    },
  ],
  operations: {
    'state/add': (async (ctx, input) => {
      const i = input as { entityType?: string; id: string; title: string; owner?: string };
      const table = { stdoc: 'state_docs', stnote: 'state_notes', stplain: 'state_plain' }[i.entityType ?? 'stdoc'];
      if (table === 'state_docs') {
        ctx.sql.exec('INSERT INTO state_docs (id, title, owner) VALUES (?, ?, ?)', [i.id, i.title, i.owner ?? 'o1']);
      } else {
        ctx.sql.exec(`INSERT INTO ${table} (id, title) VALUES (?, ?)`, [i.id, i.title]);
      }
      return { id: i.id };
    }) as Handler,
    'state/archive': (async (ctx, input) => {
      await ctx.archive(ref(input));
      return ctx.entityState(ref(input));
    }) as Handler,
    'state/unarchive': (async (ctx, input) => {
      await ctx.unarchive(ref(input));
      return ctx.entityState(ref(input));
    }) as Handler,
    'state/trash': (async (ctx, input) => {
      await ctx.trash(ref(input));
      return ctx.entityState(ref(input));
    }) as Handler,
    'state/restore': (async (ctx, input) => {
      await ctx.restore(ref(input));
      return ctx.entityState(ref(input));
    }) as Handler,
    // Transactional with the operation: an archive whose operation then throws never happened.
    'state/archive-then-throw': (async (ctx, input) => {
      await ctx.archive(ref(input));
      throw new Error('the operation failed after archiving');
    }) as Handler,
    'state/state': (async (ctx, input) => ctx.entityState(ref(input))) as Handler,
    'state/page': (async (ctx, input) => {
      const i = input as { entityType?: string; view?: 'active' | 'archived'; limit?: number; cursor?: string; filters?: Record<string, unknown>; total?: boolean };
      return ctx.page<Record<string, unknown>>(i.entityType ?? 'stdoc', {
        limit: i.limit ?? 50,
        cursor: i.cursor,
        filters: i.filters,
        total: i.total,
        view: i.view,
      });
    }) as Handler,
    'state/page-trashed': (async (ctx, input) => {
      const i = input as { entityType?: string; limit?: number; cursor?: string; total?: boolean };
      return ctx.pageTrashed<Record<string, unknown>>(i.entityType ?? 'stdoc', {
        limit: i.limit ?? 50,
        cursor: i.cursor,
        ...(i.total ? { total: true } : {}),
      });
    }) as Handler,
    'state/search': (async (ctx, input) => {
      const i = input as { term: string; view?: 'active' | 'archived' };
      return ctx.search('stdoc', i.term, i.view ? { view: i.view } : undefined);
    }) as Handler,
    'state/search-trashed': (async (ctx, input) =>
      ctx.searchTrashed('stdoc', (input as { term: string }).term)) as Handler,
    'state/history': (async (ctx, input) => readHistory({ sql: ctx.sql }, ref(input)).entries) as Handler,
    // The guard's subject: any statement, run through the module's own `ctx.sql`.
    'state/sql': (async (ctx, input) => {
      const i = input as { sql: string; params?: (string | number | null)[] };
      // A write goes through `exec`, as module code would send it; a read through `query`.
      if (!/^\s*select\b/i.test(i.sql)) return ctx.sql.exec(i.sql, i.params ?? []);
      return ctx.sql.query(i.sql, i.params ?? []);
    }) as Handler,
    /**
     * The plan SQLite chooses for the walk `ctx.page` composes — the same `listQuery`, over the
     * same plan, so the suite reads which index the real query uses rather than trusting that
     * the partial index exists.
     */
    'state/explain': (async (ctx, input) => {
      const i = input as { entityType?: string; view?: 'active' | 'archived' | 'trashed'; filters?: Record<string, unknown> };
      const plan = listIndexPlans(stateModManifest.id, stateModManifest.lists, stateModManifest.entityStates).find(
        (p) => p.entityType === (i.entityType ?? 'stdoc'),
      )!;
      const q = listQuery(plan, { limit: 10, view: i.view, filters: i.filters });
      return ctx.sql
        .query<{ detail: string }>(`EXPLAIN QUERY PLAN ${q.sql}`, q.params as (string | number)[])
        .map((row) => row.detail);
    }) as Handler,
  },
};

/**
 * The fixture behind `entityStateMigrationContractSuite` (#2090): authored migrations that
 * REBUILD a table, the create-copy-rename SQLite needs for a column type change or a dropped
 * constraint.
 *
 * On a fresh scope every rebuild runs before the derived state migrations, so it is harmless
 * there. The suite makes the scope forget one and runs the pass again — what a redeploy that
 * added it to a scope already carrying the columns, the triggers and the list indexes does.
 *
 * - `0002` rebuilds `rb_notes` (archive and trash) keeping every column.
 * - `0003` rebuilds `rb_cut` (trash) WITHOUT its state column.
 * - `0004` rebuilds `rb_plain`, which declares no state, keeping every column.
 * - `0005` + `0006` rebuild `rb_split` (trash) over TWO migrations: the first moves the table
 *   aside and creates the new one, the second copies the rows — binned ones included — across.
 * - `0007` rebuilds `rb_search`, which is searchable: its index is kept in step by triggers on
 *   the table, which subject erasure relies on to take rewritten text out of it.
 */
export const rebuildModManifest = moduleManifest.parse({
  id: '@test/rebuild',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'rb:use', description: 'use the rebuilt tables' },
    { key: 'rb:archive', description: 'archive a row' },
    { key: 'rb:trash', description: 'bin a row or restore it' },
  ],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'rebuild',
  searchables: [{ entityType: 'rbsearch', fields: ['title'], table: 'rb_search', idColumn: 'id' }],
  lists: [
    { entityType: 'rbnote', sortable: ['title'], table: 'rb_notes', idColumn: 'id' },
    { entityType: 'rbcut', sortable: ['title'], table: 'rb_cut', idColumn: 'id' },
    { entityType: 'rbplain', sortable: ['title'], table: 'rb_plain', idColumn: 'id' },
    { entityType: 'rbsplit', sortable: ['title'], table: 'rb_split', idColumn: 'id' },
  ],
  entityStates: [
    { entityType: 'rbnote', archivePermission: 'rb:archive', trashPermission: 'rb:trash', table: 'rb_notes', idColumn: 'id' },
    { entityType: 'rbcut', trashPermission: 'rb:trash', table: 'rb_cut', idColumn: 'id' },
    { entityType: 'rbsplit', trashPermission: 'rb:trash', table: 'rb_split', idColumn: 'id' },
  ],
});

const RB_TABLES = { rbnote: 'rb_notes', rbcut: 'rb_cut', rbplain: 'rb_plain', rbsplit: 'rb_split', rbsearch: 'rb_search' } as const;
const rbRef = (input: unknown): EntityRef => {
  const i = input as { entityType: string; id: string };
  return { entityType: i.entityType, entityId: i.id };
};

export const rebuildMod: ModuleRegistration = {
  manifest: rebuildModManifest,
  migrations: [
    {
      version: '0001-init',
      sql: `CREATE TABLE rb_notes (id TEXT PRIMARY KEY, title TEXT NOT NULL);
            CREATE TABLE rb_cut (id TEXT PRIMARY KEY, title TEXT NOT NULL);
            CREATE TABLE rb_plain (id TEXT PRIMARY KEY, title TEXT NOT NULL);
            CREATE TABLE rb_split (id TEXT PRIMARY KEY, title TEXT NOT NULL);
            CREATE TABLE rb_search (id TEXT PRIMARY KEY, title TEXT NOT NULL);`,
    },
    {
      version: '0002-rebuild-notes',
      sql: `CREATE TABLE rb_notes_new AS SELECT * FROM rb_notes;
            DROP TABLE rb_notes;
            ALTER TABLE rb_notes_new RENAME TO rb_notes;`,
    },
    {
      version: '0003-rebuild-cut',
      sql: `CREATE TABLE rb_cut_new AS SELECT id, title FROM rb_cut;
            DROP TABLE rb_cut;
            ALTER TABLE rb_cut_new RENAME TO rb_cut;`,
    },
    {
      version: '0004-rebuild-plain',
      sql: `CREATE TABLE rb_plain_new AS SELECT * FROM rb_plain;
            DROP TABLE rb_plain;
            ALTER TABLE rb_plain_new RENAME TO rb_plain;`,
    },
    {
      version: '0005-split-aside',
      sql: `ALTER TABLE rb_split RENAME TO rb_split_old;
            CREATE TABLE rb_split AS SELECT * FROM rb_split_old WHERE 0;`,
    },
    {
      version: '0006-split-copy',
      sql: `INSERT INTO rb_split SELECT * FROM rb_split_old;
            DROP TABLE rb_split_old;`,
    },
    {
      version: '0007-rebuild-search',
      sql: `CREATE TABLE rb_search_new AS SELECT * FROM rb_search ORDER BY id DESC;
            DROP TABLE rb_search;
            ALTER TABLE rb_search_new RENAME TO rb_search;`,
    },
  ],
  operations: {
    'rb/add': (async (ctx, input) => {
      const i = input as { entityType: keyof typeof RB_TABLES; id: string; title: string };
      ctx.sql.exec(`INSERT INTO ${RB_TABLES[i.entityType]} (id, title) VALUES (?, ?)`, [i.id, i.title]);
      return { id: i.id };
    }) as Handler,
    'rb/trash': (async (ctx, input) => ctx.trash(rbRef(input))) as Handler,
    'rb/restore': (async (ctx, input) => ctx.restore(rbRef(input))) as Handler,
    'rb/state': (async (ctx, input) => ctx.entityState(rbRef(input))) as Handler,
    // Erasure's shape: the row's text rewritten in place, or the row gone.
    'rb/retitle': (async (ctx, input) => {
      const i = input as { id: string; title: string };
      ctx.sql.exec('UPDATE rb_search SET title = ? WHERE id = ?', [i.title, i.id]);
      return null;
    }) as Handler,
    'rb/remove': (async (ctx, input) => {
      ctx.sql.exec('DELETE FROM rb_search WHERE id = ?', [(input as { id: string }).id]);
      return null;
    }) as Handler,
    'rb/search': (async (ctx, input) =>
      (await ctx.search('rbsearch', (input as { term: string }).term)).map((h) => h.id)) as Handler,
    // A module's own runtime DDL (#1811), statement by statement through `ctx.sql`.
    'rb/ddl': (async (ctx, input) => {
      for (const statement of (input as { statements: string[] }).statements) ctx.sql.exec(statement);
      return null;
    }) as Handler,
    // Several statements in ONE `ctx.sql` call — the rows of the last one.
    'rb/batch': (async (ctx, input) => ctx.sql.query((input as { sql: string }).sql)) as Handler,
    'rb/ddl-bound': (async (ctx) => ctx.sql.exec('ALTER TABLE rb_plain ADD COLUMN extra TEXT; UPDATE rb_plain SET extra = ?', ['x'])) as Handler,
    'rb/titles': (async (ctx, input) =>
      ctx.sql
        .query<{ title: string }>(`SELECT title FROM ${RB_TABLES[(input as { entityType: keyof typeof RB_TABLES }).entityType]} ORDER BY title`)
        .map((r) => r.title)) as Handler,
  },
};
