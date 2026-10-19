import { moduleManifest, type PermissionKey } from '@substrat-run/contracts';
import type { ModuleRegistration, OperationContext, OperationHandler } from '@substrat-run/kernel';
import { testOperations } from './test-operations.js';

/**
 * #2430: a module declaring one key reserved to a system principal (`holder: 'system'`) beside a
 * person's key, as engine-assistant does, and an operation reporting whether the caller holds a key,
 * so a suite observes the effect of a role door rather than the door's answer alone.
 */

export const RSV_USE = 'rsv:use' as PermissionKey;
export const RSV_RUN = 'rsv:run' as PermissionKey;

export const reservedRoleModManifest = moduleManifest.parse({
  id: '@test/reserved-role',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [
    { key: RSV_USE, description: 'a person may hold this' },
    { key: RSV_RUN, description: 'only a system principal may hold this', holder: 'system' },
  ],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'rsv',
});

export const reservedRoleMod: ModuleRegistration = {
  manifest: reservedRoleModManifest,
  migrations: [],
  ...testOperations({
    'rsv/probe': (async (ctx: OperationContext, input: { permission: PermissionKey }) => ({
      allowed: (await ctx.check(input.permission)).allowed,
    })) as unknown as OperationHandler<never, unknown>,
  }),
};
