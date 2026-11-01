/**
 * Graph notes' permission surface, read by `pnpm lint:permissions` through `package.json`
 * `substrat.permissions`, and the `MODULES` and `ROLES` a host registers.
 */
import { definePermissions, type RoleDefinition } from '@substrat-run/contracts';
import { GRAPH_NOTES_PERMISSIONS, NOTES_PERM } from './manifest.js';
import { graphNotesModule } from './module.js';

export const MODULES = [graphNotesModule];

export const ROLES: RoleDefinition[] = [
  { key: 'reader', permissions: [NOTES_PERM.read], source: 'vertical' },
  { key: 'writer', permissions: [NOTES_PERM.read, NOTES_PERM.write], source: 'vertical' },
  { key: 'admin', permissions: [NOTES_PERM.read, NOTES_PERM.write, NOTES_PERM.install], source: 'vertical' },
];

export const permissions = definePermissions({
  modules: MODULES,
  roles: ROLES,
  keys: GRAPH_NOTES_PERMISSIONS,
});
