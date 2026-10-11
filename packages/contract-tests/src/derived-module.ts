/**
 * The fixture behind `derivedHandlersContractSuite` (#1773): one module whose get, list, update
 * and delete are DERIVED — declared with `derive` and handed no handler — bound through
 * `operationsFor`, the path a vertical takes. So the suite holds the handlers the platform writes,
 * on each adapter's SQL, to the behaviour a hand-written one owes: the check first, `not_found`,
 * the partial PATCH, the 412, the event and its payload, the paged walk scoped to its parent.
 *
 * - `dfolder` — the parent a page is scoped to.
 * - `dnote` — its child: derived get / list / update / delete. The writes that seed it, and the
 *   read of its history, are authored — none of them is a derivable shape.
 * - `dtag` — another child of `dfolder`, made by a derived CREATE (#2157): keyed per folder, its
 *   time and author stamped, linked to the folder it was checked on; read and changed derived too.
 * - `dlabel` — a scope-wide derived create, with no parent and no natural key.
 * - `dshelf` — archivable and trashable, each under its own key (#119): derived archive /
 *   unarchive / trash / restore, the bin page, and a list with the archive view; a guarded derived
 *   rename, so a held tag can be carried across a move (#2191), and an authored relabel-and-archive
 *   that changes content and moves in one call.
 */
import { z } from 'zod';
import {
  defineEntities,
  defineOperations,
  entityStateOutput,
  listsDeclaredBy,
  manifestEntities,
  manifestOperations,
  moduleManifest,
  permissionKey,
  type EntityRef,
} from '@substrat-run/contracts';
import { assertAllowed, operationsFor, readHistory, type ModuleRegistration } from '@substrat-run/kernel';

export const DERIVED_MODULE_ID = '@test/derived';

export const derivedEntities = defineEntities({
  dfolder: { table: 'derived_folders', fields: z.object({ id: z.string(), name: z.string() }) },
  dnote: {
    table: 'derived_notes',
    fields: z.object({
      id: z.string(),
      dfolder_id: z.string(),
      title: z.string(),
      body: z.string().nullable(),
      rank: z.number(),
    }),
    parents: ['dfolder'],
  },
  dtag: {
    table: 'derived_tags',
    fields: z.object({
      id: z.string(),
      dfolder_id: z.string(),
      label: z.string(),
      note: z.string().nullable(),
      created_at: z.string(),
      created_by: z.string(),
    }),
    parents: ['dfolder'],
    key: ['dfolder_id', 'label'],
    stamps: { created_at: 'createdAt', created_by: 'createdBy' },
  },
  dlabel: { table: 'derived_labels', fields: z.object({ id: z.string(), name: z.string() }) },
  dshelf: {
    table: 'derived_shelves',
    fields: z.object({ id: z.string(), label: z.string() }),
    archive: { permission: 'dshelf:archive' },
    trash: { permission: 'dshelf:trash' },
  },
});

const PERMISSIONS = ['dnote:read', 'dnote:write', 'dshelf:archive', 'dshelf:trash'] as const;
const shelf = (key: 'dshelf:archive' | 'dshelf:trash') => ({ key, entity: 'dshelf', idFrom: 'shelfId' }) as const;
const byShelf = z.object({ shelfId: z.string() });
const note = (key: (typeof PERMISSIONS)[number]) => ({ key, entity: 'dnote', idFrom: 'noteId' }) as const;
const ok = z.object({ ok: z.boolean() });

export const derivedOperations = defineOperations(derivedEntities, PERMISSIONS)({
  'derived/add-folder': {
    summary: 'Add a folder',
    permission: 'dnote:write',
    input: z.object({ id: z.string(), name: z.string() }),
    output: ok,
  },
  'derived/add-note': {
    summary: 'Add a note — authored, and emitting, so the note has a version to hold',
    permission: 'dnote:write',
    input: z.object({ id: z.string(), folderId: z.string(), title: z.string(), body: z.string().nullable(), rank: z.number() }),
    output: z.object({ id: z.string() }),
    emits: { entity: 'dnote', entityIdFrom: 'id', type: 'dnote.added', schemaVersion: 1, piiClass: 'none', payload: ['id'] },
  },
  'derived/get-note': {
    summary: 'One note',
    derive: 'get',
    permission: note('dnote:read'),
    input: z.object({ noteId: z.string() }),
    output: derivedEntities.dnote.fields,
    http: { method: 'GET', path: '/notes/{noteId}' },
  },
  'derived/list-notes': {
    summary: "A folder's notes",
    derive: 'list',
    permission: { key: 'dnote:read', entity: 'dfolder', idFrom: 'dfolderId' },
    input: z.object({ dfolderId: z.string(), title: z.string().optional() }),
    output: derivedEntities.dnote.fields,
    paged: { over: { entity: 'dnote', sortable: ['rank'], filterable: ['dfolder_id', 'title'] }, total: true },
    http: { method: 'GET', path: '/folders/{dfolderId}/notes' },
  },
  'derived/update-note': {
    summary: 'Change a note',
    derive: 'update',
    permission: note('dnote:write'),
    input: z.object({
      noteId: z.string(),
      title: z.string().optional(),
      body: z.string().nullable().optional(),
      rank: z.number().optional(),
    }),
    output: derivedEntities.dnote.fields,
    http: { method: 'PATCH', path: '/notes/{noteId}' },
    concurrency: { over: 'dnote', idFrom: 'noteId' },
    emits: {
      entity: 'dnote',
      entityIdFrom: 'id',
      type: 'dnote.updated',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'title', 'body', 'rank'],
    },
  },
  'derived/delete-note': {
    summary: 'Remove a note',
    derive: 'delete',
    permission: note('dnote:write'),
    input: z.object({ noteId: z.string() }),
    output: z.object({ id: z.string(), deleted: z.boolean() }),
    http: { method: 'DELETE', path: '/notes/{noteId}' },
    emits: { entity: 'dnote', entityIdFrom: 'id', type: 'dnote.deleted', schemaVersion: 1, piiClass: 'none', payload: ['id'] },
  },
  'derived/create-tag': {
    summary: 'Tag a folder',
    derive: 'create',
    permission: { key: 'dnote:write', entity: 'dfolder', idFrom: 'dfolderId' },
    input: z.object({ dfolderId: z.string(), label: z.string(), note: z.string().nullable().optional() }),
    output: derivedEntities.dtag.fields,
    http: { method: 'POST', path: '/folders/{dfolderId}/tags' },
    emits: {
      entity: 'dtag',
      entityIdFrom: 'id',
      type: 'dtag.created',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'dfolder_id', 'label', 'created_at', 'created_by'],
    },
  },
  'derived/get-tag': {
    summary: 'One tag — narrowed to the tag, so a grant on its folder reaches it only through the link',
    derive: 'get',
    permission: { key: 'dnote:read', entity: 'dtag', idFrom: 'tagId' },
    input: z.object({ tagId: z.string() }),
    output: derivedEntities.dtag.fields,
    http: { method: 'GET', path: '/tags/{tagId}' },
  },
  'derived/update-tag': {
    summary: "Change a tag's note",
    derive: 'update',
    permission: { key: 'dnote:write', entity: 'dtag', idFrom: 'tagId' },
    input: z.object({ tagId: z.string(), note: z.string().nullable().optional() }),
    output: derivedEntities.dtag.fields,
    http: { method: 'PATCH', path: '/tags/{tagId}' },
    concurrency: { over: 'dtag', idFrom: 'tagId' },
    emits: {
      entity: 'dtag',
      entityIdFrom: 'id',
      type: 'dtag.updated',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'note', 'created_by'],
    },
  },
  'derived/create-label': {
    summary: 'Add a label',
    derive: 'create',
    permission: 'dnote:write',
    input: z.object({ name: z.string() }),
    output: derivedEntities.dlabel.fields,
    http: { method: 'POST', path: '/labels' },
    emits: { entity: 'dlabel', entityIdFrom: 'id', type: 'dlabel.created', schemaVersion: 1, piiClass: 'none', payload: ['id', 'name'] },
  },
  'derived/add-shelf': {
    summary: 'Add a shelf',
    permission: 'dnote:write',
    input: z.object({ id: z.string(), label: z.string() }),
    output: ok,
  },
  // A derived create on an archivable, trashable entity with no natural key (#2162): there is no
  // replay to answer a hidden row, so it derives. With a key it would not (`createPlan`).
  'derived/create-shelf': {
    summary: 'Add a shelf, its id minted',
    derive: 'create',
    permission: 'dnote:write',
    input: z.object({ label: z.string() }),
    output: derivedEntities.dshelf.fields,
    http: { method: 'POST', path: '/shelves' },
    emits: { entity: 'dshelf', entityIdFrom: 'id', type: 'dshelf.created', schemaVersion: 1, piiClass: 'none', payload: ['id', 'label'] },
  },
  'derived/list-shelves': {
    summary: 'The shelves, active unless the archive is asked for',
    derive: 'list',
    permission: 'dnote:read',
    input: z.object({ view: z.enum(['active', 'archived']).optional() }),
    output: derivedEntities.dshelf.fields,
    paged: { over: { entity: 'dshelf', sortable: ['label'] } },
    http: { method: 'GET', path: '/shelves' },
  },
  'derived/archive-shelf': {
    summary: 'File a shelf away',
    derive: 'archive',
    permission: shelf('dshelf:archive'),
    input: byShelf,
    output: entityStateOutput,
    http: { method: 'POST', path: '/shelves/{shelfId}/archive' },
  },
  'derived/unarchive-shelf': {
    summary: 'Bring a shelf back from the archive',
    derive: 'unarchive',
    permission: shelf('dshelf:archive'),
    input: byShelf,
    output: entityStateOutput,
    http: { method: 'POST', path: '/shelves/{shelfId}/unarchive' },
  },
  'derived/trash-shelf': {
    summary: 'Bin a shelf',
    derive: 'trash',
    permission: shelf('dshelf:trash'),
    input: byShelf,
    output: entityStateOutput,
    http: { method: 'POST', path: '/shelves/{shelfId}/trash' },
  },
  'derived/restore-shelf': {
    summary: 'Take a shelf out of the bin',
    derive: 'restore',
    permission: shelf('dshelf:trash'),
    trashed: 'admits',
    input: byShelf,
    output: entityStateOutput,
    http: { method: 'POST', path: '/shelves/{shelfId}/restore' },
  },
  'derived/rename-shelf': {
    summary: 'Rename a shelf',
    derive: 'update',
    permission: { key: 'dnote:write', entity: 'dshelf', idFrom: 'shelfId' },
    input: z.object({ shelfId: z.string(), label: z.string().optional() }),
    output: derivedEntities.dshelf.fields,
    http: { method: 'PATCH', path: '/shelves/{shelfId}' },
    concurrency: { over: 'dshelf', idFrom: 'shelfId' },
    emits: { entity: 'dshelf', entityIdFrom: 'id', type: 'dshelf.updated', schemaVersion: 1, piiClass: 'none', payload: ['id', 'label'] },
  },
  'derived/relabel-and-archive': {
    summary: 'Relabel a shelf and file it away, in one call',
    permission: { key: 'dnote:write', entity: 'dshelf', idFrom: 'shelfId' },
    input: z.object({ shelfId: z.string(), label: z.string() }),
    output: derivedEntities.dshelf.fields,
    concurrency: { over: 'dshelf', idFrom: 'shelfId' },
    emits: { entity: 'dshelf', entityIdFrom: 'id', type: 'dshelf.updated', schemaVersion: 1, piiClass: 'none', payload: ['id', 'label'] },
  },
  'derived/trashed-shelves': {
    summary: 'The bin',
    derive: 'trashed',
    narrows: { reason: 'Only the binned shelves the caller may restore', checks: ['dshelf:trash'] },
    output: derivedEntities.dshelf.fields,
    paged: { over: { entity: 'dshelf', sortable: ['label'] } },
    http: { method: 'GET', path: '/shelves/trash' },
  },
  'derived/history': {
    summary: "A note's events, after it is gone too",
    permission: 'dnote:read',
    input: z.object({ noteId: z.string() }),
    output: z.object({ entries: z.array(z.unknown()) }),
  },
});

export const derivedModManifest = moduleManifest.parse({
  id: DERIVED_MODULE_ID,
  version: '1.0.0',
  kernelContract: '^0.0.1',
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  ...manifestOperations(derivedOperations, {
    permissions: {
      'dnote:read': 'read notes',
      'dnote:write': 'write notes',
      'dshelf:archive': 'archive shelves',
      'dshelf:trash': 'bin and restore shelves',
    },
    consumes: [],
  }),
  ...manifestEntities(derivedEntities, {}),
  lists: listsDeclaredBy(derivedOperations, derivedEntities),
  entitlementKey: 'derived',
});

const WRITE = permissionKey.parse('dnote:write');
const READ = permissionKey.parse('dnote:read');
const noteRef = (id: string): EntityRef => ({ entityType: 'dnote', entityId: id });

export const derivedMod: ModuleRegistration = {
  manifest: derivedModManifest,
  migrations: [
    {
      version: '0001-init',
      sql: `CREATE TABLE derived_folders (id TEXT PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE derived_notes (id TEXT PRIMARY KEY, dfolder_id TEXT NOT NULL, title TEXT NOT NULL,
                                        body TEXT, rank INTEGER NOT NULL);
            CREATE TABLE derived_tags (id TEXT PRIMARY KEY, dfolder_id TEXT NOT NULL, label TEXT NOT NULL, note TEXT,
                                       created_at TEXT NOT NULL, created_by TEXT NOT NULL,
                                       UNIQUE (dfolder_id, label));
            CREATE TABLE derived_labels (id TEXT PRIMARY KEY, name TEXT NOT NULL);

            CREATE TABLE derived_shelves (id TEXT PRIMARY KEY, label TEXT NOT NULL);`,
    },
  ],
  // The derived operations are absent here — and could not be present: the type refuses them.
  ...operationsFor(derivedOperations)({
    'derived/add-folder': async (ctx, i) => {
      assertAllowed(await ctx.check(WRITE));
      ctx.sql.exec('INSERT INTO derived_folders (id, name) VALUES (?, ?)', [i.id, i.name]);
      return { ok: true };
    },
    'derived/add-note': async (ctx, i) => {
      assertAllowed(await ctx.check(WRITE));
      ctx.sql.exec('INSERT INTO derived_notes (id, dfolder_id, title, body, rank) VALUES (?, ?, ?, ?, ?)', [
        i.id,
        i.folderId,
        i.title,
        i.body,
        i.rank,
      ]);
      ctx.emit({ type: 'dnote.added', schemaVersion: 1, entity: noteRef(i.id), piiClass: 'none', payload: { id: i.id } });
      return { id: i.id };
    },
    'derived/add-shelf': async (ctx, i) => {
      assertAllowed(await ctx.check(WRITE));
      ctx.sql.exec('INSERT INTO derived_shelves (id, label) VALUES (?, ?)', [i.id, i.label]);
      return { ok: true };
    },
    'derived/relabel-and-archive': async (ctx, i) => {
      assertAllowed(await ctx.check(WRITE, { entityType: 'dshelf', entityId: i.shelfId }));
      ctx.sql.exec('UPDATE derived_shelves SET label = ? WHERE id = ?', [i.label, i.shelfId]);
      const entity = { entityType: 'dshelf', entityId: i.shelfId };
      ctx.emit({ type: 'dshelf.updated', schemaVersion: 1, entity, piiClass: 'none', payload: { id: i.shelfId, label: i.label } });
      await ctx.archive(entity);
      return { id: i.shelfId, label: i.label };
    },
    'derived/history': async (ctx, i) => {
      assertAllowed(await ctx.check(READ));
      // Any entity's history: a note's, a tag's, a label's or a shelf's — the id is enough to find it.
      for (const entityType of ['dnote', 'dtag', 'dlabel', 'dshelf']) {
        const { entries } = readHistory({ sql: ctx.sql }, { entityType, entityId: i.noteId });
        if (entries.length > 0) return { entries };
      }
      return { entries: [] };
    },
  }),
};
