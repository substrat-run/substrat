import {
  definePermissions,
  type PermissionKey,
  type RoleDefinition,
} from '@substrat-run/contracts';
import { workorderModule, PERM as WO } from '@substrat-run/engine-workorder';
import { invoicingModule, INVOICING_PERM as INV } from '@substrat-run/engine-invoicing';
import { bikeShopModule } from './module.js';
import { SHOP_PERM } from './manifest.js';

// The manifest's config surface rides the same import `substrat push` already makes for
// `permissions` (#1206): this export is what the push uploads, so `src/manifest.ts` is the
// single envSpec declaration and package.json carries no copy.
export { SHOP_ENV as envSpec } from './manifest.js';

// ============================================================================
// The vertical's PROVISIONING surface — everything a deployment needs to know
// about modules, roles and grant shapes, with NO node imports. Split from
// seed.ts (which pulls in node:fs + the SQLite adapter) so the Cloudflare
// worker (src/worker.ts) can bundle it, and so `substrat push` can read the
// permission registry from it (package.json `substrat.permissions`).
// ============================================================================

/**
 * The modules this vertical composes, in registration order. Registered by
 * BOTH hosts (the dev server's SqliteScopeHost and the worker's ScopeDO), and
 * read by the permission checkpoint — the artifact can never drift from what
 * actually runs.
 */
export const MODULES = [workorderModule, invoicingModule, bikeShopModule];

/** Entitlements are default-deny: one SKU key per module this vertical runs. */
export const ENTITLEMENT_KEYS = ['workorder', 'invoicing', 'bikeshop'];

const adminPerms: PermissionKey[] = [
  SHOP_PERM.customerManage,
  SHOP_PERM.bikeManage,
  WO.create,
  WO.read,
  WO.assign,
  WO.report,
  WO.complete,
  WO.close,
  INV.read,
  INV.export,
];

/**
 * This vertical's role table — identical in every tenant, so it is a plain
 * constant the permission snapshot can render without naming a tenant.
 */
export const ROLES: RoleDefinition[] = [
  { key: 'workshop-admin', permissions: adminPerms, source: 'vertical' },
  { key: 'mechanic', permissions: [WO.read, WO.report], source: 'vertical' },
];

/** Which role the installing owner holds — what /internal/provision assigns. */
export const OWNER_ROLE_KEY = 'workshop-admin';

/** What a portal customer receives, narrowed to their own customer record. */
export const portalPerms: PermissionKey[] = [WO.read];

/**
 * Entity-narrowed grant SHAPES. The grants themselves are per-principal and
 * minted at runtime, so they can never be a build artifact; their shape is what
 * tells a reviewer which keys are reachable outside the role table.
 */
export const ENTITY_GRANTS: { entityType: string; permissions: PermissionKey[] }[] = [
  { entityType: 'customer', permissions: portalPerms },
];

/**
 * The single typed source for this vertical's permission surface — what the
 * permission checkpoint and `substrat push` read (via package.json
 * `substrat.permissions`).
 */
export const permissions = definePermissions({
  modules: MODULES,
  roles: ROLES,
  entityGrants: ENTITY_GRANTS,
});
