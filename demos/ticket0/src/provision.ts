/**
 * This vertical's permission surface, as a build-time fact.
 *
 * Read by the permission checkpoint (`pnpm lint:permissions`) and by `substrat push`.
 * Derived from the same `MODULES` and `ROLES` the host registers, so the reviewed
 * artifact cannot drift from what actually runs.
 *
 * Kept out of `seed.ts` on purpose: that file imports `node:*` and a concrete adapter.
 */
import { definePermissions, type PermissionKey } from '@substrat-run/contracts';
import { T0_PERM } from './manifest.js';
import { MODULES, ROLES } from './seed.js';

/**
 * The keys reachable OUTSIDE the role table — the shapes, not the grants themselves,
 * which are per-principal ULIDs minted at runtime.
 *
 * One entry, and it is the customer side of the whole app. Nobody holds either key
 * scope-wide; each is granted to one person on their OWN contact, and their
 * conversations are reached from it through the declared parent edge. That is what
 * makes one customer's history unreachable to another.
 */
export const ENTITY_GRANTS: { entityType: string; permissions: PermissionKey[] }[] = [
  {
    entityType: 'contact',
    permissions: [T0_PERM.conversationReadOwn, T0_PERM.conversationReplyOwn],
  },
];

export const permissions = definePermissions({
  modules: MODULES,
  roles: ROLES,
  entityGrants: ENTITY_GRANTS,
});
