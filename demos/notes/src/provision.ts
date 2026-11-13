/**
 * This vertical's permission surface, as a build-time fact: read by the permission checkpoint
 * (`pnpm lint:permissions`) and by `substrat push`, through `package.json`
 * `substrat.permissions`.
 */
import { definePermissions, type RoleDefinition } from '@substrat-run/contracts';
import { NOTES_PERMISSIONS } from '../spec/model.js';
import { NOTES_PERM } from './manifest.js';
import { notesModule } from './module.js';

export const MODULES = [notesModule];

/**
 * Nobody is assigned this by hand. The door seats it from what the app that owns the people
 * answers, through {@link rolesFromTodo}, and takes it away the same way.
 */
export const ROLES: RoleDefinition[] = [
  { key: 'writer', permissions: [NOTES_PERM.noteRead, NOTES_PERM.noteWrite], source: 'vertical' },
];

/**
 * Todo's role keys, mapped onto this vertical's own. A member with plugin access is answered as
 * `member` and writes here; a key this does not name maps to nothing, so a role Todo adds later
 * gives nobody anything in Notes until this says what it means.
 */
export const rolesFromTodo = (todoRoles: readonly string[]): string[] => (todoRoles.includes('member') ? ['writer'] : []);

export const permissions = definePermissions({
  modules: MODULES,
  roles: ROLES,
  entityGrants: [],
  keys: NOTES_PERMISSIONS,
});
