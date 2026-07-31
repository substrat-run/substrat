import {
  definePermissions,
  platformActorId,
  type PermissionKey,
  type PrincipalId,
  type RoleDefinition,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { manyfoldModule } from './module.js';
import { MF_PERM } from './manifest.js';

/**
 * Provisioning ONE instance of Manyfold — what a team receives when they install
 * it from the marketplace. One tenant, a set of SITES (each a scope), one owner
 * holding `admin` tenant-wide. Split from `seed.ts` (which pulls in node:fs +
 * SqliteScopeHost) so it runs anywhere the kernel runs — SQLite locally, Durable
 * Objects in production — reaching nothing past the neutral `ScopeHost` contract.
 *
 * The demo cast (Nordlys Studio, Emil, Sofia) lives in `seed.ts` and is unreachable
 * from here: `provisionManyfold` has no room in its return type for a cast, so a real
 * install cannot accidentally receive one.
 */

export interface ManyfoldSite {
  scopeId: ScopeId;
  slug: string;
  name: string;
}

export interface ManyfoldInstance {
  tenantId: TenantId;
  /** The installing owner — holds `admin` across every site. */
  owner: PrincipalId;
  sites: ManyfoldSite[];
}

/** The modules this vertical composes — Milestone A runs the content lifecycle in the
 * vertical itself, so it's Manyfold alone (no engine yet; decision 27). Read by
 * `tools/permission-diff.mts` to render the permission checkpoint from the same array
 * the host registers, so the artifact can't drift from what actually runs. */
export const MODULES = [manyfoldModule];

const read = [MF_PERM.read];
const author = [MF_PERM.read, MF_PERM.author];
const editor = [...author, MF_PERM.review];
const publisher = [...editor, MF_PERM.publish];
const admin = [...publisher, MF_PERM.admin, MF_PERM.manageSites];

/**
 * The editorial role ladder, identical in every tenant — held PER SITE (K-22: the
 * same login is a different principal, with a different role, in each scope). A plain
 * constant so the permission snapshot renders it without naming a tenant.
 */
export const ROLES: RoleDefinition[] = [
  { key: 'viewer', permissions: read, source: 'vertical' },
  { key: 'author', permissions: author, source: 'vertical' },
  { key: 'editor', permissions: editor, source: 'vertical' },
  { key: 'publisher', permissions: publisher, source: 'vertical' },
  { key: 'admin', permissions: admin, source: 'vertical' },
];

/** No entity-narrowed grants: authority is role-based per site (node-level), not per-entity. */
export const ENTITY_GRANTS: { entityType: string; permissions: PermissionKey[] }[] = [];

/**
 * The single typed source for this vertical's permission surface — what the permission
 * checkpoint and `substrat push` read (discovered via `package.json` `substrat.permissions`).
 * Derived from the same `MODULES`/`ROLES` the host registers, so it cannot drift from what runs.
 */
export const permissions = definePermissions({ modules: MODULES, roles: ROLES, entityGrants: ENTITY_GRANTS });

/** Idempotent-ish provisioning of one Manyfold instance. */
export async function provisionManyfold(
  host: ScopeHost,
  input: { tenantId: TenantId; owner: PrincipalId; slug: string; name: string; sites: ManyfoldSite[] },
): Promise<ManyfoldInstance> {
  const staff = platformActorId.parse(ulid());

  await host.admin.createTenant(staff, { id: input.tenantId, slug: input.slug, name: input.name });
  // K-23: a provider declares its topology before an identity may link to it.
  await host.admin.registerIdentityPool(staff, { provider: 'better-auth', topology: 'central', tenantId: null });
  // Entitlements are default-deny — the SKU flag must be granted before any operation resolves.
  await host.admin.grantEntitlement(staff, input.tenantId, 'manyfold');

  for (const site of input.sites) {
    await host.provisionScope(staff, { tenantId: input.tenantId, scopeId: site.scopeId, jurisdiction: 'global' });
    // Provisioning writes the row as `provisioning`; nothing may use the scope until it
    // is active (K-31). Local platform + vertical are one process, so this is immediate.
    await host.admin.activateScope(staff, input.tenantId, site.scopeId);
  }

  for (const role of ROLES) await host.admin.defineRole(staff, input.tenantId, role);
  // The owner holds `admin` tenant-wide (scopeId: null) — admin of every site from day one.
  await host.admin.assignRole(staff, {
    principalId: input.owner,
    roleKey: 'admin',
    node: { tenantId: input.tenantId, scopeId: null },
  });

  return { tenantId: input.tenantId, owner: input.owner, sites: input.sites };
}
