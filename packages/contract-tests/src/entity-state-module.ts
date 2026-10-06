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
