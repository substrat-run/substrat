/**
 * The fixture behind #2506's third case: a module with TWO purge horizons, so one
 * `runDueSchedules` call runs two purge schedules back to back with no platform drain between
 * them — the way a module that bins two kinds of entity meets the scope's pending-request cap.
 * `schedulePlatformRequestsContractSuite` fills the queue with the first horizon's purges and asks
 * what the second one's pass does about it.
 *
 * Each purge enqueues one request, except for a row named `QUIET_TWO_ROW`, which enqueues none.
 * In a module of its own, as `schedule-purge-request-module.ts` is, so no other suite's counts move.
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

export const PURGE_TWO_MODULE_ID = '@test/purge-two';
export const PURGE_TWO_KIND = 'test.purged-two';
export const PURGE_TWO_DAYS = 7;
export const QUIET_TWO_ROW = 'quiet';

export const purgeTwoEntities = defineEntities({
  pa: {
    table: 'purgetwo_a',
    fields: z.object({ id: z.string(), name: z.string() }),
    trash: { permission: 'purgetwo:trash-a', purgeAfterDays: PURGE_TWO_DAYS },
  },
  pb: {
    table: 'purgetwo_b',
    fields: z.object({ id: z.string(), name: z.string() }),
    trash: { permission: 'purgetwo:trash-b', purgeAfterDays: PURGE_TWO_DAYS },
  },
});

const PERMISSIONS = ['purgetwo:write', 'purgetwo:trash-a', 'purgetwo:trash-b', 'purgetwo:purge-a', 'purgetwo:purge-b'] as const;
const ok = z.object({ ok: z.boolean() });
const addInput = z.object({ id: z.string(), name: z.string() });
const rowInput = z.object({ rowId: z.string() });

export const purgeTwoOperations = defineOperations(purgeTwoEntities, PERMISSIONS)({
  'purgetwo/add-a': { summary: 'Add a row', permission: 'purgetwo:write', input: addInput, output: ok },
  'purgetwo/add-b': { summary: 'Add a row', permission: 'purgetwo:write', input: addInput, output: ok },
  'purgetwo/trash-a': {
    summary: 'Bin a row',
    permission: { key: 'purgetwo:trash-a', entity: 'pa', idFrom: 'rowId' },
    input: rowInput,
    output: ok,
  },
  'purgetwo/trash-b': {
    summary: 'Bin a row',
    permission: { key: 'purgetwo:trash-b', entity: 'pb', idFrom: 'rowId' },
    input: rowInput,
    output: ok,
  },
  'purgetwo/purge-a': {
    summary: 'Delete a row for good, enqueueing a platform request',
    permission: { key: 'purgetwo:purge-a', entity: 'pa', idFrom: 'rowId' },
    trashed: 'purges',
    input: z.strictObject({ rowId: z.string() }),
    output: ok,
  },
  'purgetwo/purge-b': {
    summary: 'Delete a row for good, enqueueing a platform request',
    permission: { key: 'purgetwo:purge-b', entity: 'pb', idFrom: 'rowId' },
    trashed: 'purges',
    input: z.strictObject({ rowId: z.string() }),
    output: ok,
  },
});

type Handler = OperationHandler<never, unknown>;
type Key = Parameters<Parameters<Handler>[0]['check']>[0];
const P = (key: (typeof PERMISSIONS)[number]) => key as Key;

const adder = (table: string): Handler =>
  (async (ctx, i: { id: string; name: string }) => {
    assertAllowed(await ctx.check(P('purgetwo:write')));
    ctx.sql.exec(`INSERT INTO ${table} (id, name) VALUES (?, ?)`, [i.id, i.name]);
    return { ok: true };
  }) as Handler;
const trasher = (entityType: string): Handler =>
  (async (ctx, i: { rowId: string }) => {
    const ref: EntityRef = { entityType, entityId: i.rowId };
    await ctx.trash(ref);
    return { ok: true };
  }) as Handler;
const purger = (entityType: string, table: string, key: (typeof PERMISSIONS)[number]): Handler =>
  (async (ctx, i: { rowId: string }) => {
    assertAllowed(await ctx.check(P(key), { entityType, entityId: i.rowId }));
    const row = ctx.sql.query<{ name: string }>(`SELECT name FROM ${table} WHERE id = ?`, [i.rowId])[0];
    if (!row) return { ok: false };
    ctx.sql.exec(`DELETE FROM ${table} WHERE id = ?`, [i.rowId]);
    if (row.name !== QUIET_TWO_ROW) ctx.requestPlatform({ kind: PURGE_TWO_KIND, payload: { rowId: i.rowId } });
    return { ok: true };
  }) as Handler;

export const purgeTwoMod: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: PURGE_TWO_MODULE_ID,
    version: '1.0.0',
    kernelContract: '^0.0.1',
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    ...manifestOperations(purgeTwoOperations, {
      permissions: {
        'purgetwo:write': 'add a row',
        'purgetwo:trash-a': 'bin a row of the first kind',
        'purgetwo:trash-b': 'bin a row of the second kind',
        'purgetwo:purge-a': 'delete a row of the first kind for good',
        'purgetwo:purge-b': 'delete a row of the second kind for good',
      },
      consumes: [],
    }),
    ...manifestEntities(purgeTwoEntities, {}),
    schedules: purgeSchedulesOf(purgeTwoOperations, purgeTwoEntities),
    entitlementKey: 'sched',
  }),
  migrations: [
    {
      version: '0001-init',
      sql:
        'CREATE TABLE purgetwo_a (id TEXT PRIMARY KEY, name TEXT NOT NULL);' +
        'CREATE TABLE purgetwo_b (id TEXT PRIMARY KEY, name TEXT NOT NULL);',
    },
  ],
  ...testOperations(
    {
      'purgetwo/add-a': adder('purgetwo_a'),
      'purgetwo/add-b': adder('purgetwo_b'),
      'purgetwo/trash-a': trasher('pa'),
      'purgetwo/trash-b': trasher('pb'),
      'purgetwo/purge-a': purger('pa', 'purgetwo_a', 'purgetwo:purge-a'),
      'purgetwo/purge-b': purger('pb', 'purgetwo_b', 'purgetwo:purge-b'),
    },
    { inputs: operationInputsOf(purgeTwoOperations) },
  ),
};
