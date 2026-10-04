/**
 * The fixture vertical's permission surface — what `substrat push` reads (`substrat.permissions`),
 * and so where the schedule the platform owes a sweeper for is declared: `fixture/tick`, every
 * hour, under the module's system grant. Its own module rather than contract-tests'
 * `scheduleMod`, because the push imports this file as data, outside any test runner, and
 * contract-tests loads vitest.
 */
import {
  definePermissions,
  moduleManifest,
  type PermissionKey,
  type RoleDefinition,
} from '@substrat-run/contracts';
import { assertAllowed, type ModuleRegistration, type OperationHandler } from '@substrat-run/kernel';

const TICK = 'fixture:tick' as PermissionKey;

export const fixtureModule: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: '@fixture/scheduled',
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [{ key: TICK, description: 'run the scheduled tick' }],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'fixture',
    schedules: [{ operation: 'fixture/tick', cadence: { everyMinutes: 60 }, permissions: [TICK] }],
  }),
  migrations: [{ version: '0001-init', sql: 'CREATE TABLE fixture_ticks (n INTEGER NOT NULL)' }],
  operations: {
    'fixture/tick': (async (ctx) => {
      assertAllowed(await ctx.check(TICK));
      ctx.sql.exec('INSERT INTO fixture_ticks (n) VALUES (1)');
    }) as OperationHandler<never, unknown>,
    'fixture/count': ((ctx) =>
      ctx.sql.query<{ n: number }>('SELECT COUNT(*) AS n FROM fixture_ticks')[0]!.n) as OperationHandler<never, unknown>,
  },
};

export const MODULES = [fixtureModule];

export const OWNER_ROLE_KEY = 'owner';
export const ROLES: RoleDefinition[] = [{ key: OWNER_ROLE_KEY, permissions: [TICK], source: 'vertical' }];

export const permissions = definePermissions({ modules: MODULES, roles: ROLES });
