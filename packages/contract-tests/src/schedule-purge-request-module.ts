/**
 * The fixture behind #2440: a purge horizon whose purge operation enqueues a platform request,
 * so `schedulePlatformRequestsContractSuite` can ask whether the schedule run reports what its
 * purges enqueued. Declared the way a vertical declares a purge (`defineEntities`,
 * `purgeSchedulesOf`), as `entity-trash-module.ts` is, in a module of its own so no other
 * suite's sweep counts move.
 *
 * `purgereq/purge` enqueues one request per purge, except for a row named `QUIET_PURGE_ROW`,
 * which enqueues none — the twin that a count of what was enqueued, not of what was purged — and
 * one named `GREEDY_PURGE_ROW`, which enqueues more than a scope will ever have room for (#2506).
 * `purgereq/enqueue` fills the scope's queue with requests of another kind, standing for traffic
 * (or stuck rows) that are not the purge's.
 */
import { z } from 'zod';
import {
  MAX_PENDING_PLATFORM_REQUESTS,
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
export const GREEDY_PURGE_ROW = 'greedy';
export const FILLER_KIND = 'test.filler';

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
  'purgereq/enqueue': {
    summary: 'Enqueue platform requests that are not a purge\'s',
    permission: 'purgereq:write',
    input: z.object({ count: z.number().int().min(1).max(MAX_PENDING_PLATFORM_REQUESTS) }),
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
      'purgereq/enqueue': (async (ctx, i: { count: number }) => {
        assertAllowed(await ctx.check(P('purgereq:write')));
        for (let n = 0; n < i.count; n++) ctx.requestPlatform({ kind: FILLER_KIND, payload: { n } });
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
        // One request per purge; none for the quiet row; more than the cap allows for the greedy one,
        // whose purge therefore rolls back whole however empty the queue is.
        const requests = row.name === QUIET_PURGE_ROW ? 0 : row.name === GREEDY_PURGE_ROW ? MAX_PENDING_PLATFORM_REQUESTS + 1 : 1;
        for (let n = 0; n < requests; n++) ctx.requestPlatform({ kind: PURGE_REQUEST_KIND, payload: { rowId: i.rowId } });
        return { ok: true };
      }) as Handler,
    },
    { inputs: operationInputsOf(purgeRequestOperations) },
  ),
};
