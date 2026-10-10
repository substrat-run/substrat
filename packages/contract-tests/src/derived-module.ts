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
 */
import { z } from 'zod';
import {
  defineEntities,
  defineOperations,
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
      folder_id: z.string(),
      title: z.string(),
      body: z.string().nullable(),
      rank: z.number(),
    }),
    parents: ['dfolder'],
  },
});

const PERMISSIONS = ['dnote:read', 'dnote:write'] as const;
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
    permission: { key: 'dnote:read', entity: 'dfolder', idFrom: 'folderId' },
    input: z.object({ folderId: z.string(), title: z.string().optional() }),
    output: derivedEntities.dnote.fields,
    paged: { over: { entity: 'dnote', sortable: ['rank'], filterable: ['folder_id', 'title'] }, total: true },
    http: { method: 'GET', path: '/folders/{folderId}/notes' },
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
    permissions: { 'dnote:read': 'read notes', 'dnote:write': 'write notes' },
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
            CREATE TABLE derived_notes (id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, title TEXT NOT NULL,
                                        body TEXT, rank INTEGER NOT NULL);`,
    },
  ],
  // The four derived operations are absent here — and could not be present: the type refuses them.
  ...operationsFor(derivedOperations)({
    'derived/add-folder': async (ctx, i) => {
      assertAllowed(await ctx.check(WRITE));
      ctx.sql.exec('INSERT INTO derived_folders (id, name) VALUES (?, ?)', [i.id, i.name]);
      return { ok: true };
    },
    'derived/add-note': async (ctx, i) => {
      assertAllowed(await ctx.check(WRITE));
      ctx.sql.exec('INSERT INTO derived_notes (id, folder_id, title, body, rank) VALUES (?, ?, ?, ?, ?)', [
        i.id,
        i.folderId,
        i.title,
        i.body,
        i.rank,
      ]);
      ctx.emit({ type: 'dnote.added', schemaVersion: 1, entity: noteRef(i.id), piiClass: 'none', payload: { id: i.id } });
      return { id: i.id };
    },
    'derived/history': async (ctx, i) => {
      assertAllowed(await ctx.check(READ));
      return { entries: readHistory({ sql: ctx.sql }, noteRef(i.noteId)).entries };
    },
  }),
};
