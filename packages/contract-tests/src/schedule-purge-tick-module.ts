/**
 * The fixture behind #2517's bound: a module whose ORDINARY schedule fills the scope's
 * pending-request queue every time it runs, declared before its purge horizon, so one
 * `runDueSchedules` call runs the fill and then the purge with no drain between them. An ordinary
 * schedule can enqueue on every tick for ever, so the queue it fills must never defer a purge head:
 * `schedulePlatformRequestsContractSuite` asks that the head fails as before and that the purges
 * behind it that need no request still commit.
 *
 * Each purge enqueues one request, except for a row named `QUIET_TICK_ROW`, which enqueues none.
 * In a module of its own, as `schedule-purge-two-module.ts` is, so no other suite's counts move.
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
} from '@substrat-run/contracts';
import { assertAllowed, type ModuleRegistration, type OperationHandler } from '@substrat-run/kernel';
import { testOperations } from './test-operations.js';

export const PURGE_TICK_MODULE_ID = '@test/purge-tick';
export const PURGE_TICK_KIND = 'test.purged-tick';
export const PURGE_TICK_FILL_KIND = 'test.tick-fill';
export const PURGE_TICK_DAYS = 7;
export const QUIET_TICK_ROW = 'quiet';

export const purgeTickEntities = defineEntities({
  ptk: {
    table: 'purgetick_rows',
    fields: z.object({ id: z.string(), name: z.string() }),
    trash: { permission: 'purgetick:trash', purgeAfterDays: PURGE_TICK_DAYS },
  },
});

const PERMISSIONS = ['purgetick:write', 'purgetick:trash', 'purgetick:purge', 'purgetick:fill'] as const;
const ok = z.object({ ok: z.boolean() });

export const purgeTickOperations = defineOperations(purgeTickEntities, PERMISSIONS)({
  'purgetick/add': { summary: 'Add a row', permission: 'purgetick:write', input: z.object({ id: z.string(), name: z.string() }), output: ok },
  'purgetick/trash': {
    summary: 'Bin a row',
    permission: { key: 'purgetick:trash', entity: 'ptk', idFrom: 'rowId' },
    input: z.object({ rowId: z.string() }),
    output: ok,
  },
  'purgetick/purge': {
    summary: 'Delete a row for good, enqueueing a platform request',
    permission: { key: 'purgetick:purge', entity: 'ptk', idFrom: 'rowId' },
    trashed: 'purges',
    input: z.strictObject({ rowId: z.string() }),
    output: ok,
  },
  'purgetick/fill': { summary: 'Fill the platform-request queue', permission: 'purgetick:fill', input: z.object({}), output: ok },
});

type Handler = OperationHandler<never, unknown>;
type Key = Parameters<Parameters<Handler>[0]['check']>[0];
const P = (key: (typeof PERMISSIONS)[number]) => key as Key;

export const purgeTickMod: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: PURGE_TICK_MODULE_ID,
    version: '1.0.0',
    kernelContract: '^0.0.1',
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    ...manifestOperations(purgeTickOperations, {
      permissions: {
        'purgetick:write': 'add a row',
        'purgetick:trash': 'bin a row',
        'purgetick:purge': 'delete a row for good',
        'purgetick:fill': 'fill the platform-request queue',
      },
      consumes: [],
    }),
    ...manifestEntities(purgeTickEntities, {}),
    // The ordinary schedule first, as a module's declared schedules come before its derived purges.
    schedules: [
      { operation: 'purgetick/fill', cadence: { everyMinutes: 60 }, permissions: ['purgetick:fill'], input: {} },
      ...purgeSchedulesOf(purgeTickOperations, purgeTickEntities),
    ],
    entitlementKey: 'sched',
  }),
  migrations: [{ version: '0001-init', sql: 'CREATE TABLE purgetick_rows (id TEXT PRIMARY KEY, name TEXT NOT NULL);' }],
  ...testOperations(
    {
      'purgetick/add': (async (ctx, i: { id: string; name: string }) => {
        assertAllowed(await ctx.check(P('purgetick:write')));
        ctx.sql.exec('INSERT INTO purgetick_rows (id, name) VALUES (?, ?)', [i.id, i.name]);
        return { ok: true };
      }) as Handler,
      'purgetick/trash': (async (ctx, i: { rowId: string }) => {
        await ctx.trash({ entityType: 'ptk', entityId: i.rowId });
        return { ok: true };
      }) as Handler,
      'purgetick/purge': (async (ctx, i: { rowId: string }) => {
        assertAllowed(await ctx.check(P('purgetick:purge'), { entityType: 'ptk', entityId: i.rowId }));
        const row = ctx.sql.query<{ name: string }>('SELECT name FROM purgetick_rows WHERE id = ?', [i.rowId])[0];
        if (!row) return { ok: false };
        ctx.sql.exec('DELETE FROM purgetick_rows WHERE id = ?', [i.rowId]);
        if (row.name !== QUIET_TICK_ROW) ctx.requestPlatform({ kind: PURGE_TICK_KIND, payload: { rowId: i.rowId } });
        return { ok: true };
      }) as Handler,
      'purgetick/fill': (async (ctx) => {
        assertAllowed(await ctx.check(P('purgetick:fill')));
        for (let n = 0; n < MAX_PENDING_PLATFORM_REQUESTS; n++) ctx.requestPlatform({ kind: PURGE_TICK_FILL_KIND, payload: { n } });
        return { ok: true };
      }) as Handler,
    },
    { inputs: operationInputsOf(purgeTickOperations) },
  ),
};
