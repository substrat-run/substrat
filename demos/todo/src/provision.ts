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
import { definePermissions, type PermissionKey } from '@substrat-run/contracts';
import { TODO_PERM } from './manifest.js';
import { MODULES, ROLES } from './seed.js';

/**
 * The keys reachable OUTSIDE the role table — the shapes, not the grants
 * themselves, which are per-principal ULIDs minted at runtime.
 *
 * Both entries are the interesting half of this app. `owner` is the bootstrap: a
 * person holds these on their own entity, and their lists inherit through the
 * declared parent edge. `list` is sharing: `ctx.grant` narrows `list:contribute`
 * onto ONE list for ONE person, which is the only way anybody reaches a list
 * that is not theirs.
 */
export const ENTITY_GRANTS: { entityType: string; permissions: PermissionKey[] }[] = [
  { entityType: 'owner', permissions: [TODO_PERM.listManage, TODO_PERM.listContribute] },
  { entityType: 'list', permissions: [TODO_PERM.listContribute] },
];

export const permissions = definePermissions({
  modules: MODULES,
  roles: ROLES,
  entityGrants: ENTITY_GRANTS,
});
