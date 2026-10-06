/**
 * The fixture behind `entityTrashContractSuite` (#119 PR 2): the host's trash refusal, the
 * link refusal and the purge horizon, declared the way a vertical declares them — through
 * `defineEntities`, `defineOperations`, `operationInputsOf` and `purgeSchedulesOf` — so the
 * suite is held against the producers a vertical actually calls, not a hand-written copy.
 *
 * - `tbox` — archivable and trashable, purged after `TBOX_PURGE_DAYS` by `trash/delete-box`.
 * - `tthing` — a child of `tbox`, for `ctx.link` / `ctx.relink`.
 * - `tkeep` — trashable with NO horizon: in the bin forever, whatever the sweep does.
 *
 * One operation per refusal shape: refused by default (`rename-box`), `trashed: 'admits'`
 * (`restore-box`, `peek-box`, `link-thing`, `move-thing`), `trashed: 'purges'`
 * (`delete-box`), and a check `resolved` in the handler (`touch-thing`) the host cannot see.
 */
import { z } from 'zod';
import {
  defineEntities,
  defineOperations,
  manifestEntities,
  manifestOperations,
  moduleManifest,
  operationInputsOf,
  purgeSchedulesOf,
  type EntityRef,
} from '@substrat-run/contracts';
import { assertAllowed, readHistory, type ModuleRegistration, type OperationHandler } from '@substrat-run/kernel';

export const TRASH_MODULE_ID = '@test/trash';
export const TBOX_PURGE_DAYS = 7;
/** A box whose purge always fails after deleting — a crash inside the purge's transaction. */
export const EXPLODING_BOX = 'explode';

export const trashEntities = defineEntities({
  tbox: {
    table: 'trash_boxes',
    fields: z.object({ id: z.string(), name: z.string() }),
    archive: { permission: 'box:archive' },
    trash: { permission: 'box:trash', purgeAfterDays: TBOX_PURGE_DAYS },
  },
  tthing: {
    table: 'trash_things',
    fields: z.object({ id: z.string(), box_id: z.string() }),
    parents: ['tbox'],
  },
  tkeep: {
    table: 'trash_keeps',
    fields: z.object({ id: z.string() }),
    trash: { permission: 'box:trash' },
  },
});

const PERMISSIONS = ['box:read', 'box:write', 'box:archive', 'box:trash', 'box:delete'] as const;
const boxId = z.object({ boxId: z.string() });
const box = (key: (typeof PERMISSIONS)[number]) => ({ key, entity: 'tbox', idFrom: 'boxId' }) as const;
const ok = z.object({ ok: z.boolean() });

export const trashOperations = defineOperations(trashEntities, PERMISSIONS)({
  'trash/add-box': {
    summary: 'Add a box',
    permission: 'box:write',
    input: z.object({ id: z.string(), name: z.string() }),
    output: ok,
  },
  'trash/add-keep': {
    summary: 'Add a keep',
    permission: 'box:write',
    input: z.object({ id: z.string() }),
    output: ok,
  },
  'trash/bin-many': {
    summary: 'Add and bin many boxes in one call — the fixture for a full purge batch',
    permission: 'box:write',
    input: z.object({ prefix: z.string(), count: z.number().int().positive() }),
    output: z.object({ ids: z.array(z.string()) }),
  },
  'trash/rename-box': {
    summary: 'Rename a box — refused on a trashed one by the host',
    permission: box('box:write'),
    input: z.object({ boxId: z.string(), name: z.string() }),
    output: ok,
  },
  'trash/archive-box': { summary: 'Archive a box', permission: box('box:archive'), input: boxId, output: ok },
  'trash/trash-box': { summary: 'Bin a box', permission: box('box:trash'), input: boxId, output: ok },
  'trash/trash-keep': {
    summary: 'Bin a keep',
    permission: { key: 'box:trash', entity: 'tkeep', idFrom: 'keepId' },
    input: z.object({ keepId: z.string() }),
    output: ok,
  },
  'trash/restore-box': {
    summary: 'Restore a box from the bin',
    permission: box('box:trash'),
    trashed: 'admits',
    input: boxId,
    output: ok,
  },
  'trash/peek-box': {
    summary: "A box's state, binned or not",
    permission: box('box:read'),
    trashed: 'admits',
    input: boxId,
    output: z.object({ state: z.string().nullable() }),
  },
  'trash/delete-box': {
    summary: 'Delete a box and its things for good — the purge horizon runs this',
    permission: box('box:delete'),
    trashed: 'purges',
    input: boxId,
    output: z.object({ ok: z.boolean(), boxId: z.string() }),
    emits: { entity: 'tbox', entityIdFrom: 'boxId', type: 'trashbox.deleted', schemaVersion: 1, piiClass: 'none' },
  },
  'trash/other-delete': {
    summary: 'Another operation checking the purge key — the system principal may not run it',
    permission: box('box:delete'),
    input: boxId,
    output: ok,
  },
  'trash/link-thing': {
    summary: 'Hang a thing off a box — admits a binned box, so ctx.link is what refuses',
    permission: box('box:write'),
    trashed: 'admits',
    input: z.object({ boxId: z.string(), thingId: z.string() }),
    output: ok,
  },
  'trash/move-thing': {
    summary: 'Move a thing to another box — admits a binned box, so ctx.relink is what refuses',
    permission: box('box:write'),
    trashed: 'admits',
    input: z.object({ boxId: z.string(), thingId: z.string(), fromBoxId: z.string() }),
    output: ok,
  },
  'trash/touch-thing': {
    summary: 'Touch a thing — its check is resolved, so the host cannot refuse it (the stated gap)',
    permission: { key: 'box:write', entity: 'tbox', resolved: 'the box the thing is in' },
    input: z.object({ thingId: z.string() }),
    output: ok,
  },
  'trash/box-exists': {
    summary: 'Whether a box row exists at all',
    permission: 'box:read',
    input: boxId,
    output: z.object({ exists: z.boolean(), things: z.number() }),
  },
  'trash/ddl': {
    summary: "Runtime DDL through ctx.sql — after which the kernel checks every stateful table is intact",
    permission: 'box:write',
    input: z.object({ table: z.string() }),
    output: ok,
  },
  'trash/history': {
    summary: "A box's event history, after it is gone too",
    permission: 'box:read',
    input: boxId,
    output: z.object({ entries: z.array(z.unknown()) }),
  },
});

export const trashModManifest = moduleManifest.parse({
  id: TRASH_MODULE_ID,
  version: '1.0.0',
  kernelContract: '^0.0.1',
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  ...manifestOperations(trashOperations, {
    permissions: {
      'box:read': 'read boxes',
      'box:write': 'write boxes',
      'box:archive': 'archive a box',
      'box:trash': 'bin a box or restore it',
      'box:delete': 'delete a box for good',
    },
    consumes: [],
  }),
  ...manifestEntities(trashEntities, {}),
  schedules: purgeSchedulesOf(trashOperations, trashEntities),
  entitlementKey: 'trash',
});

type Handler = OperationHandler<never, unknown>;
const boxRef = (id: string): EntityRef => ({ entityType: 'tbox', entityId: id });
const thingRef = (id: string): EntityRef => ({ entityType: 'tthing', entityId: id });
const P = (key: (typeof PERMISSIONS)[number]) => key as Parameters<Parameters<Handler>[0]['check']>[0];

export const trashMod: ModuleRegistration = {
  manifest: trashModManifest,
  migrations: [
    {
      version: '0001-init',
      sql: `CREATE TABLE trash_boxes (id TEXT PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE trash_things (id TEXT PRIMARY KEY, box_id TEXT NOT NULL);
            CREATE TABLE trash_keeps (id TEXT PRIMARY KEY);`,
    },
  ],
  // The host derives each operation's target from these — the same declarations it parses with.
  operationInputs: operationInputsOf(trashOperations),
  // Every handler checks its declared key first, as a vertical's does — the host's refusal has
  // to agree with that order, which is what the suite asserts.
  operations: {
    'trash/add-box': (async (ctx, i: { id: string; name: string }) => {
      assertAllowed(await ctx.check(P('box:write')));
      ctx.sql.exec('INSERT INTO trash_boxes (id, name) VALUES (?, ?)', [i.id, i.name]);
      return { ok: true };
    }) as Handler,
    'trash/add-keep': (async (ctx, i: { id: string }) => {
      assertAllowed(await ctx.check(P('box:write')));
      ctx.sql.exec('INSERT INTO trash_keeps (id) VALUES (?)', [i.id]);
      return { ok: true };
    }) as Handler,
    'trash/bin-many': (async (ctx, i: { prefix: string; count: number }) => {
      assertAllowed(await ctx.check(P('box:write')));
      const ids: string[] = [];
      for (let n = 0; n < i.count; n++) {
        const id = `${i.prefix}${String(n).padStart(4, '0')}`;
        ctx.sql.exec('INSERT INTO trash_boxes (id, name) VALUES (?, ?)', [id, id]);
        await ctx.trash(boxRef(id));
        ids.push(id);
      }
      return { ids };
    }) as Handler,
    'trash/rename-box': (async (ctx, i: { boxId: string; name: string }) => {
      assertAllowed(await ctx.check(P('box:write'), boxRef(i.boxId)));
      ctx.sql.exec('UPDATE trash_boxes SET name = ? WHERE id = ?', [i.name, i.boxId]);
      return { ok: true };
    }) as Handler,
    'trash/archive-box': (async (ctx, i: { boxId: string }) => {
      await ctx.archive(boxRef(i.boxId));
      return { ok: true };
    }) as Handler,
    'trash/trash-box': (async (ctx, i: { boxId: string }) => {
      await ctx.trash(boxRef(i.boxId));
      return { ok: true };
    }) as Handler,
    'trash/trash-keep': (async (ctx, i: { keepId: string }) => {
      await ctx.trash({ entityType: 'tkeep', entityId: i.keepId });
      return { ok: true };
    }) as Handler,
    'trash/restore-box': (async (ctx, i: { boxId: string }) => {
      await ctx.restore(boxRef(i.boxId));
      return { ok: true };
    }) as Handler,
    'trash/peek-box': (async (ctx, i: { boxId: string }) => {
      assertAllowed(await ctx.check(P('box:read'), boxRef(i.boxId)));
      return { state: ctx.entityState(boxRef(i.boxId)) };
    }) as Handler,
    'trash/delete-box': (async (ctx, i: { boxId: string }) => {
      assertAllowed(await ctx.check(P('box:delete'), boxRef(i.boxId)));
      const row = ctx.sql.query<{ name: string }>('SELECT name FROM trash_boxes WHERE id = ?', [i.boxId])[0];
      if (!row) return { ok: false, boxId: i.boxId };
      // The vertical's cascade rule, which is why the horizon runs this and not a kernel DELETE.
      ctx.sql.exec('DELETE FROM trash_things WHERE box_id = ?', [i.boxId]);
      ctx.sql.exec('DELETE FROM trash_boxes WHERE id = ?', [i.boxId]);
      ctx.emit({
        type: 'trashbox.deleted',
        schemaVersion: 1,
        entity: boxRef(i.boxId),
        piiClass: 'none',
        payload: { boxId: i.boxId },
      });
      if (row.name === EXPLODING_BOX) throw new Error('the purge crashed after deleting — everything rolls back');
      return { ok: true, boxId: i.boxId };
    }) as Handler,
    'trash/other-delete': (async (ctx, i: { boxId: string }) => {
      assertAllowed(await ctx.check(P('box:delete'), boxRef(i.boxId)));
      return { ok: true };
    }) as Handler,
    'trash/link-thing': (async (ctx, i: { boxId: string; thingId: string }) => {
      assertAllowed(await ctx.check(P('box:write'), boxRef(i.boxId)));
      ctx.sql.exec('INSERT OR IGNORE INTO trash_things (id, box_id) VALUES (?, ?)', [i.thingId, i.boxId]);
      ctx.link(thingRef(i.thingId), boxRef(i.boxId));
      return { ok: true };
    }) as Handler,
    'trash/move-thing': (async (ctx, i: { boxId: string; thingId: string; fromBoxId: string }) => {
      assertAllowed(await ctx.check(P('box:write'), boxRef(i.boxId)));
      ctx.relink(thingRef(i.thingId), boxRef(i.fromBoxId), boxRef(i.boxId));
      ctx.sql.exec('UPDATE trash_things SET box_id = ? WHERE id = ?', [i.boxId, i.thingId]);
      return { ok: true };
    }) as Handler,
    'trash/touch-thing': (async (ctx, i: { thingId: string }) => {
      const thing = ctx.sql.query<{ box_id: string }>('SELECT box_id FROM trash_things WHERE id = ?', [i.thingId])[0];
      if (!thing) throw new Error('no such thing');
      assertAllowed(await ctx.check(P('box:write'), boxRef(thing.box_id)));
      return { ok: true };
    }) as Handler,
    'trash/box-exists': (async (ctx, i: { boxId: string }) => {
      assertAllowed(await ctx.check(P('box:read')));
      const exists = ctx.sql.query('SELECT 1 AS x FROM trash_boxes WHERE id = ?', [i.boxId]).length > 0;
      const things = ctx.sql.query('SELECT 1 AS x FROM trash_things WHERE box_id = ?', [i.boxId]).length;
      return { exists, things };
    }) as Handler,
    'trash/ddl': (async (ctx, i: { table: string }) => {
      assertAllowed(await ctx.check(P('box:write')));
      ctx.sql.exec(`CREATE TABLE ${i.table} (id TEXT)`);
      return { ok: true };
    }) as Handler,
    'trash/history': (async (ctx, i: { boxId: string }) => {
      assertAllowed(await ctx.check(P('box:read')));
      return { entries: readHistory({ sql: ctx.sql }, boxRef(i.boxId)).entries };
    }) as Handler,
  },
};
