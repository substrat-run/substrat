import { definePermissions, type RoleDefinition } from '@substrat-run/contracts';
import { PERMISSIONS } from '../spec/model.js';
import { ENTITY_GRANTS, LISTS_PERM } from './manifest.js';
import { listsModule } from './module.js';

export { ENTITY_GRANTS };
// What `substrat push` uploads as this vertical's settings, off the same import it reads `permissions` from.
export { LISTS_ENV as envSpec } from './manifest.js';

export const MODULES = [listsModule];

export const ROLES: RoleDefinition[] = [
  { key: 'list-member', permissions: [LISTS_PERM.listCreate], source: 'vertical' },
];

/** Which role the installing owner holds (what /internal/provision assigns): a member like any other. */
export const OWNER_ROLE_KEY = 'list-member';

export const permissions = definePermissions({
  modules: MODULES,
  roles: ROLES,
  entityGrants: ENTITY_GRANTS,
  keys: PERMISSIONS,
});
