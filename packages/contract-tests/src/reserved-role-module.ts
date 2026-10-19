import { moduleManifest, type PermissionKey } from '@substrat-run/contracts';
import type { ModuleRegistration } from '@substrat-run/kernel';
import { testOperations } from './test-operations.js';

/**
 * #2430: a module declaring one key reserved to a system principal (`holder: 'system'`) beside a
 * person's key, as engine-assistant does. It binds no operation: the suite observes a door's
 * effect through `permMod`'s `perm/probe`.
 */

export const RSV_USE = 'rsv:use' as PermissionKey;
export const RSV_RUN = 'rsv:run' as PermissionKey;

export const reservedRoleMod: ModuleRegistration = {
  manifest: moduleManifest.parse({
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
  }),
  migrations: [],
  ...testOperations({}),
};
