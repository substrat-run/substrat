/**
 * The fixture behind `delegationCeilingContractSuite` (#3161): two keys a person holds, and
 * operations that ask for each in the ways a ceiling has to reach — a plain check, a check after a
 * write, the grant-scoped read behind a filtered list, and `ctx.canAssign`'s bound — and one whose
 * every run answers differently, so a replay can be told from a fresh run.
 */
import { z } from 'zod';
import { defineEntities, defineOperations, manifestOperations, moduleManifest, permissionKey } from '@substrat-run/contracts';
import { assertAllowed, operationsFor, type ModuleRegistration } from '@substrat-run/kernel';

export const DELEGATION_CEILING_MODULE_ID = '@test/delegation-ceiling';
export const CEILING_A = permissionKey.parse('ceiling:a');
export const CEILING_B = permissionKey.parse('ceiling:b');
export const CEILING_ENTITY = 'ceiling_thing';

const entities = defineEntities({});
const ok = z.object({ ok: z.boolean() });

const ceilingOperations = defineOperations(entities, ['ceiling:a', 'ceiling:b'] as const)({
  'ceiling/a': { summary: 'Asks for A', permission: 'ceiling:a', output: ok },
  'ceiling/b': { summary: 'Asks for B', permission: 'ceiling:b', output: ok },
  'ceiling/a-then-b': { summary: 'Asks for A, writes a row, then asks for B', permission: 'ceiling:a', output: ok },
  'ceiling/mark': { summary: 'Asks for A and writes a row: each run answers a new count', permission: 'ceiling:a', output: z.object({ rows: z.number() }) },
  'ceiling/rows': { summary: 'How many rows `a-then-b` left', permission: 'ceiling:a', output: z.object({ rows: z.number() }) },
  'ceiling/granted-b': {
    summary: 'The grant-scoped read a filtered list makes, over B',
    permission: 'ceiling:a',
    output: z.object({ kind: z.string(), ids: z.array(z.string()).optional() }),
  },
  'ceiling/can-assign': {
    summary: 'Whether the caller may hand on a role holding A and B',
    permission: 'ceiling:a',
    output: z.object({ covered: z.boolean(), missing: z.array(z.string()) }),
  },
});

/** The tenant role the suite seats the person in: both keys. */
export const CEILING_ROLE = 'ceiling-both';

export const delegationCeilingMod: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: DELEGATION_CEILING_MODULE_ID,
    version: '1.0.0',
    kernelContract: '^0.0.1',
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    ...manifestOperations(ceilingOperations, {
      permissions: { 'ceiling:a': 'the delegated key', 'ceiling:b': 'a key the person holds and did not delegate' },
      consumes: [],
    }),
    attachmentTargets: [],
    entitlementKey: 'delegation-ceiling',
  }),
  migrations: [{ version: '0001-init', sql: 'CREATE TABLE ceiling_rows (id INTEGER PRIMARY KEY AUTOINCREMENT);' }],
  ...operationsFor(ceilingOperations)({
    'ceiling/a': async (ctx) => {
      assertAllowed(await ctx.check(CEILING_A));
      return { ok: true };
    },
    'ceiling/b': async (ctx) => {
      assertAllowed(await ctx.check(CEILING_B));
      return { ok: true };
    },
    'ceiling/a-then-b': async (ctx) => {
      assertAllowed(await ctx.check(CEILING_A));
      ctx.sql.exec('INSERT INTO ceiling_rows DEFAULT VALUES', []);
      assertAllowed(await ctx.check(CEILING_B));
      return { ok: true };
    },
    'ceiling/mark': async (ctx) => {
      assertAllowed(await ctx.check(CEILING_A));
      ctx.sql.exec('INSERT INTO ceiling_rows DEFAULT VALUES', []);
      const [row] = ctx.sql.query<{ n: number }>('SELECT COUNT(*) AS n FROM ceiling_rows', []);
      return { rows: Number(row?.n ?? 0) };
    },
    'ceiling/rows': async (ctx) => {
      assertAllowed(await ctx.check(CEILING_A));
      const [row] = ctx.sql.query<{ n: number }>('SELECT COUNT(*) AS n FROM ceiling_rows', []);
      return { rows: Number(row?.n ?? 0) };
    },
    'ceiling/granted-b': async (ctx) => {
      assertAllowed(await ctx.check(CEILING_A));
      const page = await ctx.grantedEntities(CEILING_B, CEILING_ENTITY);
      return page.kind === 'ids' ? { kind: page.kind, ids: page.ids } : { kind: page.kind };
    },
    'ceiling/can-assign': async (ctx) => {
      assertAllowed(await ctx.check(CEILING_A));
      const { covered, missing } = await ctx.canAssign(CEILING_ROLE);
      return { covered, missing: [...missing] };
    },
  }),
};
