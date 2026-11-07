import { definePermissions, type RoleDefinition } from '@substrat-run/contracts';
import { PERMISSIONS } from '../spec/model.js';
import { ENTITY_GRANTS, LISTS_PERM } from './manifest.js';
import { listsModule } from './module.js';

export { ENTITY_GRANTS };

export const MODULES = [listsModule];

export const ROLES: RoleDefinition[] = [
  { key: 'list-member', permissions: [LISTS_PERM.listCreate], source: 'vertical' },
];

export const permissions = definePermissions({
  modules: MODULES,
  roles: ROLES,
  entityGrants: ENTITY_GRANTS,
  keys: PERMISSIONS,
});
