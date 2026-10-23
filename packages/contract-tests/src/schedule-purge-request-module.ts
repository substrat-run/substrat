/**
 * The fixture behind #2440: a purge horizon whose purge operation enqueues a platform request,
 * so `schedulePlatformRequestsContractSuite` can ask whether the schedule run reports what its
 * purges enqueued. Declared the way a vertical declares a purge (`defineEntities`,
 * `purgeSchedulesOf`), as `entity-trash-module.ts` is, in a module of its own so no other
 * suite's sweep counts move.
 *
 * `purgereq/purge` enqueues one request per purge, except for a row named `QUIET_PURGE_ROW`,
 * which enqueues none — the twin that a count of what was enqueued, not of what was purged.
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
import { assertAllowed, type ModuleRegistration, type OperationHandler } from '@substrat-run/kernel';
import { testOperations } from './test-operations.js';

export const PURGE_REQUEST_MODULE_ID = '@test/purge-request';
export const PURGE_REQUEST_KIND = 'test.purged';
export const PURGE_REQUEST_DAYS = 7;
export const QUIET_PURGE_ROW = 'quiet';

export const purgeRequestEntities = defineEntities({
  preq: {
    table: 'purgereq_rows',
    fields: z.object({ id: z.string(), name: z.string() }),
    trash: { permission: 'purgereq:trash', purgeAfterDays: PURGE_REQUEST_DAYS },
  },
});

const PERMISSIONS = ['purgereq:write', 'purgereq:trash', 'purgereq:purge'] as const;
const ok = z.object({ ok: z.boolean() });

export const purgeRequestOperations = defineOperations(purgeRequestEntities, PERMISSIONS)({
  'purgereq/add': {
    summary: 'Add a row',
    permission: 'purgereq:write',
    input: z.object({ id: z.string(), name: z.string() }),
    output: ok,
  },
  'purgereq/trash': {
    summary: 'Bin a row',
    permission: { key: 'purgereq:trash', entity: 'preq', idFrom: 'rowId' },
    input: z.object({ rowId: z.string() }),
    output: ok,
  },
  'purgereq/purge': {
    summary: 'Delete a row for good, enqueueing a platform request — the purge horizon runs this',
    permission: { key: 'purgereq:purge', entity: 'preq', idFrom: 'rowId' },
    trashed: 'purges',
    input: z.strictObject({ rowId: z.string() }),
    output: ok,
  },
});

type Handler = OperationHandler<never, unknown>;
const ref = (id: string): EntityRef => ({ entityType: 'preq', entityId: id });
const P = (key: (typeof PERMISSIONS)[number]) => key as Parameters<Parameters<Handler>[0]['check']>[0];

export const purgeRequestMod: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: PURGE_REQUEST_MODULE_ID,
    version: '1.0.0',
    kernelContract: '^0.0.1',
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    ...manifestOperations(purgeRequestOperations, {
      permissions: {
        'purgereq:write': 'add a row',
        'purgereq:trash': 'bin a row',
        'purgereq:purge': 'delete a row for good',
      },
      consumes: [],
    }),
    ...manifestEntities(purgeRequestEntities, {}),
    schedules: purgeSchedulesOf(purgeRequestOperations, purgeRequestEntities),
    entitlementKey: 'sched',
  }),
  migrations: [
    { version: '0001-init', sql: 'CREATE TABLE purgereq_rows (id TEXT PRIMARY KEY, name TEXT NOT NULL);' },
  ],
  ...testOperations(
    {
      'purgereq/add': (async (ctx, i: { id: string; name: string }) => {
        assertAllowed(await ctx.check(P('purgereq:write')));
        ctx.sql.exec('INSERT INTO purgereq_rows (id, name) VALUES (?, ?)', [i.id, i.name]);
        return { ok: true };
      }) as Handler,
      'purgereq/trash': (async (ctx, i: { rowId: string }) => {
        await ctx.trash(ref(i.rowId));
        return { ok: true };
      }) as Handler,
      'purgereq/purge': (async (ctx, i: { rowId: string }) => {
        assertAllowed(await ctx.check(P('purgereq:purge'), ref(i.rowId)));
        const row = ctx.sql.query<{ name: string }>('SELECT name FROM purgereq_rows WHERE id = ?', [i.rowId])[0];
        if (!row) return { ok: false };
        ctx.sql.exec('DELETE FROM purgereq_rows WHERE id = ?', [i.rowId]);
        if (row.name !== QUIET_PURGE_ROW) ctx.requestPlatform({ kind: PURGE_REQUEST_KIND, payload: { rowId: i.rowId } });
        return { ok: true };
      }) as Handler,
    },
    { inputs: operationInputsOf(purgeRequestOperations) },
  ),
};
