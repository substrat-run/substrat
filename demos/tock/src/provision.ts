/**
 * This vertical's permission surface, as a build-time fact.
 *
 * Read by the permission checkpoint (`pnpm lint:permissions`) and by `substrat push`,
 * discovered through `package.json` `substrat.permissions`. Derived from the same `MODULES`
 * and `ROLES` the host registers, so the reviewed artifact cannot drift from what runs.
 *
 * Kept out of `seed.ts` on purpose: that file imports `node:*` and a concrete adapter, and
 * anything importing provisioning from there would drag both into environments that cannot
 * load them.
 */
import { definePermissions, type PermissionKey } from '@substrat-run/contracts';
import { TOCK_PERMISSIONS } from '../spec/model.js';
import { MODULES, ROLES } from './seed.js';

/**
 * Empty, and that is the interesting fact about this app rather than a gap.
 *
 * Every permission here is held workspace-wide or not at all, because a run belongs to the
 * workspace and not to whoever uploaded it — there is no "this is my run" the way a record
 * app has "this is my list". Nothing is ever narrowed onto one entity by `ctx.grant`, so the
 * entity-grant shapes a reviewer would look for genuinely do not exist.
 *
 * The per-entity checks the handlers make (`ctx.check(perm, runRef(id))`) are the same
 * workspace-wide keys asked about a specific row, which is a narrower QUESTION and not a
 * narrower grant.
 */
export const ENTITY_GRANTS: { entityType: string; permissions: PermissionKey[] }[] = [];

/**
 * `keys` is the SAME array `spec/model.ts` hands `defineOperations`.
 *
 * It has to be written somewhere as literals — a manifest's keys are branded by the time
 * anything can read them back — so passing it here is what makes the restatement checked:
 * `definePermissions` throws at load if this vertical declares a key the array does not name,
 * or the other way round.
 */
export const permissions = definePermissions({
  modules: MODULES,
  roles: ROLES,
  entityGrants: ENTITY_GRANTS,
  keys: TOCK_PERMISSIONS,
});
