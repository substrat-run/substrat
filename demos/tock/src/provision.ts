/**
 * This vertical's permission surface, as a build-time fact.
 *
 * Read by the permission checkpoint (`pnpm lint:permissions`) and by `substrat push`,
 * discovered through `package.json` `substrat.permissions`. Derived from the same `MODULES`
 * and `ROLES` the host registers, so the reviewed artifact cannot drift from what runs.
 *
 * `MODULES` and `ROLES` are declared HERE rather than in `seed.ts`, and the direction
 * matters: `seed.ts` imports `node:*` and a concrete adapter, so reading them from there
 * would drag both into every consumer of this file — the permission checkpoint, `substrat
 * push`, and any worker that later compiles it. The comment below used to claim this
 * separation while the import went the other way and undid it.
 *
 * Nothing here may import a host, an adapter or `node:*`.
 */
import { definePermissions, type PermissionKey, type RoleDefinition } from '@substrat-run/contracts';
import { TOCK_PERMISSIONS } from '../spec/model.js';
import { TOCK_PERM } from './manifest.js';
import { tockModule } from './module.js';

export const MODULES = [tockModule];

/**
 * Four roles, cumulative, and the cut that matters is between the first two.
 *
 * A viewer reads the counts and never the rows, because the rows carry a pseudonymous subject
 * key and the stored source file carries the addresses it was derived from. Everything above
 * that line differs only in what it may CHANGE.
 */
export const ROLES: RoleDefinition[] = [
  { key: 'viewer', permissions: [TOCK_PERM.reportRead], source: 'vertical' },
  { key: 'analyst', permissions: [TOCK_PERM.reportRead, TOCK_PERM.rowRead, TOCK_PERM.runManage], source: 'vertical' },
  {
    key: 'modeller',
    permissions: [TOCK_PERM.reportRead, TOCK_PERM.rowRead, TOCK_PERM.runManage, TOCK_PERM.schemaManage],
    source: 'vertical',
  },
  /**
   * `admin` holds exactly what `modeller` holds, and the permission artifact says so.
   *
   * Not an oversight and not a role waiting to be collapsed: what separates an admin in the
   * approved concept is managing people, and membership is the platform's invite surface
   * rather than an operation of this vertical. So the distinction is real to a human and
   * invisible to the permission table, which is the honest state of it — merging the two
   * would contradict the design, and inventing a key nobody checks would be worse.
   */
  {
    key: 'admin',
    permissions: [TOCK_PERM.reportRead, TOCK_PERM.rowRead, TOCK_PERM.runManage, TOCK_PERM.schemaManage],
    source: 'vertical',
  },
];

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
