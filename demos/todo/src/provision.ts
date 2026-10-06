/**
 * This vertical's permission surface, as a build-time fact.
 *
 * Read by the permission checkpoint (`pnpm lint:permissions`) and by
 * `substrat push`, discovered through `package.json` `substrat.permissions`.
 * Derived from the same `MODULES` and `ROLES` the host registers, so the
 * reviewed artifact cannot drift from what actually runs.
 *
 * Kept out of `seed.ts` on purpose: that file imports `node:*` and a concrete
 * adapter, and anything importing provisioning from there would drag both into
 * environments that cannot load them.
 */
import { definePermissions } from '@substrat-run/contracts';
import { TODO_PERMISSIONS } from '../spec/model.js';
import { ENTITY_GRANTS } from './manifest.js';
import { MODULES, ROLES } from './seed.js';

export { ENTITY_GRANTS };

/**
 * `keys` is the SAME array `spec/model.ts` hands `defineOperations` (#1208).
 *
 * It has to be written somewhere as literals — a manifest's keys are branded by the
 * time anything can read them back, so the union that turns a mistyped `permission:`
 * into a compile error cannot be derived from `MODULES`. Passing it here is what makes
 * the restatement checked: `definePermissions` throws at load if this vertical ever
 * declares a key the array does not name, or the other way round.
 */
export const permissions = definePermissions({
  modules: MODULES,
  roles: ROLES,
  entityGrants: ENTITY_GRANTS,
  keys: TODO_PERMISSIONS,
});
