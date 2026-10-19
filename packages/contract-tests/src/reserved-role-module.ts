import { moduleManifest, type EntityRef, type PermissionKey, type PrincipalId } from '@substrat-run/contracts';
import type { ModuleRegistration, OperationContext, OperationHandler } from '@substrat-run/kernel';
import { testOperations } from './test-operations.js';

/**
 * #2430: a module declaring one key reserved to a system principal (`holder: 'system'`) beside a
 * person's key, as engine-assistant does, and `rsv/share`, which shares a key on an entity through
 * `ctx.grant` as whoever invokes it. The suite observes a door's effect through `permMod`'s
 * `perm/probe`.
 */

export const RSV_USE = 'rsv:use' as PermissionKey;
export const RSV_RUN = 'rsv:run' as PermissionKey;

const reservedRoleManifest = {
  id: '@test/reserved-role',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [
    { key: RSV_USE, description: 'a person may hold this' },
    { key: RSV_RUN, description: 'only a system principal may hold this', holder: 'system' as const },
  ],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'rsv',
};

const operations = () =>
  testOperations({
    'rsv/share': (async (ctx: OperationContext, input: { principal: PrincipalId; permission: PermissionKey; entity: EntityRef }) => {
      await ctx.grant(input.principal, input.permission, input.entity);
    }) as unknown as OperationHandler<never, unknown>,
  });

export const reservedRoleMod: ModuleRegistration = {
  manifest: moduleManifest.parse(reservedRoleManifest),
  migrations: [],
  ...operations(),
};

/** The same module id with `rsv:run` declared unmarked: a registration that sheds the reservation. */
export const unmarkedReservedRoleMod: ModuleRegistration = {
  manifest: moduleManifest.parse({
    ...reservedRoleManifest,
    permissions: reservedRoleManifest.permissions.map(({ key, description }) => ({ key, description })),
  }),
  migrations: [],
  ...operations(),
};
