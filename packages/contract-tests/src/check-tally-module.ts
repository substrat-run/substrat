/**
 * The fixture behind `checkTallyContractSuite` (#2387): one module bound through `operationsFor`,
 * the path a vertical takes, so the host reads which operations are held to a check from a real
 * declaration — and one bound with `testOperations`, which declares nothing.
 *
 * Every authored operation that declares `permission` is held. Each one below asks in a different
 * way, or does not ask, and none of them asserts the decision, so each COMPLETES whatever the
 * caller holds: the question the host answers is whether it asked, never what the answer was.
 */
import { z } from 'zod';
import {
  defineEntities,
  defineOperations,
  manifestOperations,
  moduleManifest,
  permissionKey,
  type PermissionKey,
} from '@substrat-run/contracts';
import { assertAllowed, operationsFor, type ModuleRegistration, type OperationContext, type OperationHandler } from '@substrat-run/kernel';
import { testOperations } from './test-operations.js';

export const CHECK_TALLY_MODULE_ID = '@test/check-tally';

const entities = defineEntities({});
const PERMISSIONS = ['tally:act', 'tally:never-held'] as const;
const ACT = permissionKey.parse('tally:act');
const NEVER_HELD = permissionKey.parse('tally:never-held');

const written = z.object({ written: z.number() });
const nothing = z.object({ ok: z.boolean() });

export const checkTallyOperations = defineOperations(entities, PERMISSIONS)({
  'tally/checks': { summary: 'Asks, and returns the answer', permission: 'tally:act', output: z.object({ allowed: z.boolean() }) },
  'tally/silent': { summary: 'Writes a row and asks nothing', permission: 'tally:act', output: written },
  'tally/via-helper': { summary: 'Asks inside a helper', permission: 'tally:act', output: nothing },
  'tally/caught': { summary: 'Asks, is refused, and carries on', permission: 'tally:act', output: nothing },
  'tally/malformed': { summary: 'Asks with a key that does not parse', permission: 'tally:act', output: nothing },
  'tally/in-atomic': { summary: 'Asks inside a sub-transaction', permission: 'tally:act', output: nothing },
  'tally/throws': { summary: 'Fails before asking', permission: 'tally:act', output: nothing },
  'tally/count': { summary: 'How many rows `silent` left', permission: 'tally:act', output: written },
  'tally/declared-none': {
    summary: 'Declares that it checks nothing',
    narrows: { reason: 'the fixture for the declared exception', checks: [], unchecked: true },
    output: nothing,
  },
  'tally/empty-walk': {
    summary: 'A per-row walk over nothing',
    narrows: { reason: 'checks each row it returns, and returns none', checks: ['tally:act'] },
    output: nothing,
  },
});

const manifest = moduleManifest.parse({
  id: CHECK_TALLY_MODULE_ID,
  version: '1.0.0',
  kernelContract: '^0.0.1',
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  ...manifestOperations(checkTallyOperations, {
    permissions: { 'tally:act': 'drive the check-tally fixture', 'tally:never-held': 'a key no one holds' },
    consumes: [],
  }),
  attachmentTargets: [],
  entitlementKey: 'check-tally',
});

/** A check made somewhere other than the handler's own body — the shape a real one usually takes. */
async function mayAct(ctx: OperationContext): Promise<boolean> {
  return (await ctx.check(ACT)).allowed;
}

export const checkTallyMod: ModuleRegistration = {
  manifest,
  migrations: [{ version: '0001-init', sql: 'CREATE TABLE tally_rows (id INTEGER PRIMARY KEY AUTOINCREMENT);' }],
  ...operationsFor(checkTallyOperations)({
    'tally/checks': async (ctx) => ({ allowed: (await ctx.check(ACT)).allowed }),
    'tally/silent': async (ctx) => {
      ctx.sql.exec('INSERT INTO tally_rows DEFAULT VALUES', []);
      return { written: 1 };
    },
    'tally/via-helper': async (ctx) => {
      await mayAct(ctx);
      return { ok: true };
    },
    'tally/caught': async (ctx) => {
      try {
        assertAllowed(await ctx.check(NEVER_HELD));
      } catch {
        /* refused, and the operation goes on without it — still a check it made */
      }
      return { ok: true };
    },
    'tally/malformed': async (ctx) => {
      try {
        await ctx.check('Not A Key!' as PermissionKey);
      } catch {
        /* the key did not parse; asking was still the operation's doing */
      }
      return { ok: true };
    },
    'tally/in-atomic': async (ctx) => {
      await ctx.atomic(async () => {
        await ctx.check(ACT);
      });
      return { ok: true };
    },
    'tally/throws': async () => {
      throw new Error('tally/throws: refused before asking anything');
    },
    'tally/count': async (ctx) => {
      await ctx.check(ACT);
      const [row] = ctx.sql.query<{ n: number }>('SELECT COUNT(*) AS n FROM tally_rows', []);
      return { written: Number(row?.n ?? 0) };
    },
    'tally/declared-none': async () => ({ ok: true }),
    'tally/empty-walk': async () => ({ ok: true }),
  }),
};

export const UNDECLARED_TALLY_MODULE_ID = '@test/check-tally-undeclared';

/** A module that declares no operation surface, so no key it promised to check. */
export const undeclaredTallyMod: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: UNDECLARED_TALLY_MODULE_ID,
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'check-tally',
  }),
  ...testOperations({
    'tally-undeclared/silent': (async () => ({ ok: true })) as OperationHandler<never, unknown>,
  }),
};
