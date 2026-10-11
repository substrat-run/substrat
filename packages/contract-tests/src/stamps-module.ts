/**
 * The fixture behind `updatedStampsContractSuite` (#2166): an entity that declares all four stamps,
 * written by derived and authored handlers alike, and one that declares only `createdAt`.
 *
 * - `sdoc` — every stamp, and archivable: a derived create, get, update and archive, plus authored
 *   writes that stamp the updated pair right or wrong on purpose (`stamp`), an authored delete, a
 *   write inside a `ctx.atomic` that is rolled back, and a consumer that writes the row.
 * - `splain` — the created stamp only: an authored write that stamps nothing is never checked.
 *
 * Inert for every other suite: nothing else invokes a `stamps/*` operation or reads its tables.
 */
import { z } from 'zod';
import {
  defineEntities,
  defineOperations,
  entityStateOutput,
  manifestEntities,
  manifestOperations,
  moduleManifest,
  permissionKey,
  type DomainEvent,
  type EntityRef,
} from '@substrat-run/contracts';
import { assertAllowed, operationsFor, readHistory, type ModuleRegistration, type OperationContext } from '@substrat-run/kernel';

export const STAMPS_MODULE_ID = '@test/stamps';

/** A time no call is ever made at. */
export const STALE_TIME = '2000-01-01T00:00:00.000Z';

export const stampsEntities = defineEntities({
  sdoc: {
    table: 'stamped_docs',
    fields: z.object({
      id: z.string(),
      title: z.string(),
      created_at: z.string(),
      created_by: z.string(),
      updated_at: z.string(),
      updated_by: z.string(),
    }),
    archive: { permission: 'sdoc:archive' },
    stamps: { created_at: 'createdAt', created_by: 'createdBy', updated_at: 'updatedAt', updated_by: 'updatedBy' },
  },
  splain: {
    table: 'stamped_plain',
    fields: z.object({ id: z.string(), title: z.string(), created_at: z.string() }),
    stamps: { created_at: 'createdAt' },
  },
});

/** How an authored write stamps the updated pair: right, or wrong in one particular way. */
export const STAMP_MODES = ['both', 'skip-at', 'skip-by', 'constant', 'other'] as const;
export type StampMode = (typeof STAMP_MODES)[number];

const PERMISSIONS = ['sdoc:read', 'sdoc:write', 'sdoc:archive'] as const;
const doc = (key: (typeof PERMISSIONS)[number]) => ({ key, entity: 'sdoc', idFrom: 'docId' }) as const;
const byId = z.object({ id: z.string() });
const touched = { entity: 'sdoc', entityIdFrom: 'id', type: 'sdoc.touched', schemaVersion: 1, piiClass: 'none', payload: ['id'] } as const;

export const stampsOperations = defineOperations(stampsEntities, PERMISSIONS)({
  'stamps/create-doc': {
    summary: 'Add a doc, every stamp written by the platform',
    derive: 'create',
    permission: 'sdoc:write',
    input: z.object({ title: z.string() }),
    output: stampsEntities.sdoc.fields,
    http: { method: 'POST', path: '/docs' },
    emits: { entity: 'sdoc', entityIdFrom: 'id', type: 'sdoc.created', schemaVersion: 1, piiClass: 'none', payload: ['id', 'title'] },
  },
  'stamps/get-doc': {
    summary: 'One doc',
    derive: 'get',
    permission: doc('sdoc:read'),
    input: z.object({ docId: z.string() }),
    output: stampsEntities.sdoc.fields,
    http: { method: 'GET', path: '/docs/{docId}' },
  },
  'stamps/update-doc': {
    summary: "Change a doc's title",
    derive: 'update',
    permission: doc('sdoc:write'),
    input: z.object({ docId: z.string(), title: z.string().optional() }),
    output: stampsEntities.sdoc.fields,
    http: { method: 'PATCH', path: '/docs/{docId}' },
    concurrency: { over: 'sdoc', idFrom: 'docId' },
    emits: { entity: 'sdoc', entityIdFrom: 'id', type: 'sdoc.updated', schemaVersion: 1, piiClass: 'none', payload: ['id', 'title'] },
  },
  'stamps/archive-doc': {
    summary: 'File a doc away — a kernel move',
    derive: 'archive',
    permission: doc('sdoc:archive'),
    input: z.object({ docId: z.string() }),
    output: entityStateOutput,
    http: { method: 'POST', path: '/docs/{docId}/archive' },
  },
  'stamps/add-doc': {
    summary: 'Add a doc by hand, with or without the updated pair',
    permission: 'sdoc:write',
    input: z.object({ id: z.string(), title: z.string(), stampUpdated: z.boolean() }),
    output: byId,
    emits: { entity: 'sdoc', entityIdFrom: 'id', type: 'sdoc.added', schemaVersion: 1, piiClass: 'none', payload: ['id'] },
  },
  'stamps/touch-doc': {
    summary: "Change a doc's title by hand, stamping as told",
    permission: 'sdoc:write',
    input: z.object({ id: z.string(), title: z.string(), stamp: z.enum(STAMP_MODES) }),
    output: byId,
    emits: touched,
  },
  'stamps/atomic-touch': {
    summary: 'Write a doc without its stamps inside a ctx.atomic that is rolled back',
    permission: 'sdoc:write',
    input: z.object({ id: z.string(), title: z.string() }),
    output: byId,
    emits: touched,
  },
  'stamps/remove-doc': {
    summary: 'Delete a doc by hand',
    permission: 'sdoc:write',
    input: byId,
    output: byId,
    emits: { entity: 'sdoc', entityIdFrom: 'id', type: 'sdoc.removed', schemaVersion: 1, piiClass: 'none', payload: ['id'] },
  },
  'stamps/poke': {
    summary: 'Ask the consumer to write a doc, stamping as told — the event is about the plain row',
    permission: 'sdoc:write',
    input: z.object({ id: z.string(), stamp: z.enum(STAMP_MODES) }),
    output: byId,
    emits: { entity: 'splain', entityIdFrom: 'id', type: 'sdoc.poked', schemaVersion: 1, piiClass: 'none', payload: ['id'] },
  },
  'stamps/history': {
    summary: "How many events name a doc — what a rolled-back write must leave unchanged",
    permission: 'sdoc:read',
    input: byId,
    output: z.object({ events: z.number() }),
  },
  'stamps/touch-plain': {
    summary: 'Write a plain row, which declares no updated stamp',
    permission: 'sdoc:write',
    input: z.object({ id: z.string(), title: z.string() }),
    output: byId,
    emits: { entity: 'splain', entityIdFrom: 'id', type: 'splain.touched', schemaVersion: 1, piiClass: 'none', payload: ['id'] },
  },
});

export const stampsManifest = moduleManifest.parse({
  id: STAMPS_MODULE_ID,
  version: '1.0.0',
  kernelContract: '^0.0.1',
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  ...manifestOperations(stampsOperations, {
    permissions: { 'sdoc:read': 'read docs', 'sdoc:write': 'write docs', 'sdoc:archive': 'archive docs' },
    consumes: [{ type: 'sdoc.poked', schemaVersion: 1 }],
  }),
  ...manifestEntities(stampsEntities, {}),
  entitlementKey: 'stamps',
});

const WRITE = permissionKey.parse('sdoc:write');
const READ = permissionKey.parse('sdoc:read');
const docRef = (id: string): EntityRef => ({ entityType: 'sdoc', entityId: id });

/** The updated pair as `mode` writes it: this call's, or wrong in one particular way. */
function updatedPair(ctx: OperationContext, mode: StampMode): { set: string; values: string[] } {
  const now = ctx.now();
  const me = String(ctx.principal);
  switch (mode) {
    case 'both':
      return { set: ', updated_at = ?, updated_by = ?', values: [now, me] };
    case 'skip-at':
      return { set: ', updated_by = ?', values: [me] };
    case 'skip-by':
      return { set: ', updated_at = ?', values: [now] };
    case 'constant':
      return { set: ', updated_at = ?, updated_by = ?', values: [STALE_TIME, me] };
    case 'other':
      return { set: ', updated_at = ?, updated_by = ?', values: [now, 'someone-else'] };
  }
}

function touchDoc(ctx: OperationContext, id: string, title: string, mode: StampMode): void {
  const pair = updatedPair(ctx, mode);
  ctx.sql.exec(`UPDATE stamped_docs SET title = ?${pair.set} WHERE id = ?`, [title, ...pair.values, id]);
  ctx.emit({ type: 'sdoc.touched', schemaVersion: 1, entity: docRef(id), piiClass: 'none', payload: { id } });
}

export const stampsMod: ModuleRegistration = {
  manifest: stampsManifest,
  migrations: [
    {
      version: '0001-init',
      sql: `CREATE TABLE stamped_docs (id TEXT PRIMARY KEY, title TEXT NOT NULL,
                                       created_at TEXT NOT NULL, created_by TEXT NOT NULL,
                                       updated_at TEXT NOT NULL, updated_by TEXT NOT NULL);
            CREATE TABLE stamped_plain (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);`,
    },
  ],
  ...operationsFor(stampsOperations)({
    'stamps/add-doc': async (ctx, i) => {
      assertAllowed(await ctx.check(WRITE));
      const now = ctx.now();
      const me = String(ctx.principal);
      // Without the pair, an older update's: the row is new, so its updated stamps are this call's too.
      const updated = i.stampUpdated ? [now, me] : [STALE_TIME, me];
      ctx.sql.exec(
        'INSERT INTO stamped_docs (id, title, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)',
        [i.id, i.title, now, me, ...updated],
      );
      ctx.emit({ type: 'sdoc.added', schemaVersion: 1, entity: docRef(i.id), piiClass: 'none', payload: { id: i.id } });
      return { id: i.id };
    },
    'stamps/touch-doc': async (ctx, i) => {
      assertAllowed(await ctx.check(WRITE));
      touchDoc(ctx, i.id, i.title, i.stamp);
      return { id: i.id };
    },
    'stamps/atomic-touch': async (ctx, i) => {
      assertAllowed(await ctx.check(WRITE));
      try {
        await ctx.atomic(() => {
          touchDoc(ctx, i.id, i.title, 'skip-at');
          throw new Error('rolled back on purpose');
        });
      } catch {
        // The write and its event are gone; nothing this call commits names the doc.
      }
      return { id: i.id };
    },
    'stamps/remove-doc': async (ctx, i) => {
      assertAllowed(await ctx.check(WRITE));
      ctx.sql.exec('DELETE FROM stamped_docs WHERE id = ?', [i.id]);
      ctx.emit({ type: 'sdoc.removed', schemaVersion: 1, entity: docRef(i.id), piiClass: 'none', payload: { id: i.id } });
      return { id: i.id };
    },
    'stamps/poke': async (ctx, i) => {
      assertAllowed(await ctx.check(WRITE));
      ctx.emit({
        type: 'sdoc.poked',
        schemaVersion: 1,
        entity: { entityType: 'splain', entityId: i.id },
        piiClass: 'none',
        payload: { id: i.id, stamp: i.stamp },
      });
      return { id: i.id };
    },
    'stamps/history': async (ctx, i) => {
      assertAllowed(await ctx.check(READ));
      return { events: readHistory({ sql: ctx.sql }, docRef(i.id), { limit: 100 }).entries.length };
    },
    'stamps/touch-plain': async (ctx, i) => {
      assertAllowed(await ctx.check(WRITE));
      ctx.sql.exec(
        'INSERT INTO stamped_plain (id, title, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET title = excluded.title',
        [i.id, i.title, ctx.now()],
      );
      ctx.emit({ type: 'splain.touched', schemaVersion: 1, entity: { entityType: 'splain', entityId: i.id }, piiClass: 'none', payload: { id: i.id } });
      return { id: i.id };
    },
  }),
  consumers: {
    // Writes the doc the poke names as the consumer's own principal, stamping as the poke says.
    'sdoc.poked': async (ctx: OperationContext, event: DomainEvent) => {
      const { id, stamp } = z.object({ id: z.string(), stamp: z.enum(STAMP_MODES) }).parse(event.payload);
      touchDoc(ctx, id, `consumed ${stamp}`, stamp);
    },
  },
};
