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
import { workorderModule, PERM as WO } from '@substrat-run/engine-workorder';
import { invoicingModule, INVOICING_PERM as INV } from '@substrat-run/engine-invoicing';
import { protocolModule, PROTOCOL_PERM as PROTO } from '@substrat-run/engine-protocol';
import { calloutModule } from './module.js';
import { SC_PERM } from './manifest.js';

/**
 * Provisioning ONE instance of this vertical — what a customer receives.
 *
 * Split out of `seed.ts` so it can run ANYWHERE the kernel runs. `seed.ts` imports
 * `node:fs` and `SqliteScopeHost`, so anything importing provisioning from there
 * dragged `better-sqlite3` and node built-ins along with it — which the Cloudflare
 * worker cannot load and the module-code rules forbid. The seam was already right;
 * the file boundary was not.
 *
 * The host is the neutral `ScopeHost` contract rather than a concrete adapter, so
 * the same function provisions on SQLite locally and on Durable Objects in
 * production. Nothing here reaches past that contract.
 *
 * The demo story — a second company, an attacker, BRF Grunden — lives in `seed.ts`
 * and is unreachable from this file. That separation is #31 blockers 3 and 4, and it
 * is structural rather than remembered: this module cannot see the cast.
 */

/**
 * What ANY instance of this vertical has: one tenant, one scope, an owner.
 *
 * This is the boundary #31 blocker 3 is about. Everything below it — a second
 * company, an attacker, BRF Grunden — is the DEMO STORY, and a customer who
 * instantiates the template must not receive it. Keeping the two types separate
 * is what makes that structural rather than remembered: `provisionCallout`
 * cannot return a cast because its return type has no room for one.
 */
export interface CalloutInstance {
  tenantId: TenantId;
  scopeId: ScopeId;
  /** The first office-admin — whoever provisioned it. */
  owner: PrincipalId;
}

/**
 * The modules this vertical composes, in registration order — which is a
 * migration-ordering contract: the protocol engine's 0001-init must journal
 * before callout's 0003-protocols-to-engine copies milestone-A data into its
 * tables.
 *
 * Exported because `tools/permission-diff.mts` renders the permission
 * checkpoint from this same array — the emitter and the running host read the
 * one object, so the artifact cannot drift from what is actually registered.
 */
export const MODULES = [workorderModule, invoicingModule, protocolModule, calloutModule];

const officePerms = [
  SC_PERM.customerManage, SC_PERM.facilityManage,
  WO.create, WO.read, WO.assign, WO.report, WO.complete, WO.close,
  INV.read, INV.export,
  PROTO.create, PROTO.fill, PROTO.sign, PROTO.read, PROTO.void,
];

/**
 * This vertical's role table — identical in every tenant, which is why it is a
 * plain constant and why the permission snapshot can render it without naming a
 * tenant. Per-tenant customisation is a console concern (runtime), not a
 * build-time one. Exported for the same reason as MODULES.
 */
export const ROLES: RoleDefinition[] = [
  { key: 'office-admin', permissions: officePerms, source: 'vertical' },
  // Technicians fill protocols; SIGNING stays with the office (arbetsledare) —
  // the fill/sign permission split from engine-protocol.md §4.6.
  { key: 'technician', permissions: [WO.read, WO.report, PROTO.read, PROTO.fill], source: 'vertical' },
];

/** What a portal customer receives, narrowed to their own customer record. */
export const portalPerms = [WO.read];

/**
 * Entity-narrowed grant SHAPES. The grants themselves are per-principal and
 * minted at runtime, so they can never be a build artifact; their shape can, and
 * it is what tells a reviewer which keys are reachable outside the role table.
 */
export const ENTITY_GRANTS: { entityType: string; permissions: PermissionKey[] }[] = [
  { entityType: 'customer', permissions: portalPerms },
];

/**
 * The single typed source for this vertical's permission surface — what the permission
 * checkpoint and `substrat push` read (discovered via `package.json` `substrat.permissions`).
 * Derived from the same `MODULES`/`ROLES` the host registers, so it cannot drift from what runs.
 */
export const permissions = definePermissions({ modules: MODULES, roles: ROLES, entityGrants: ENTITY_GRANTS });


/** Idempotent: safe on every server start; demo data seeds only once. */
/**
 * Provision ONE instance of this vertical — what a customer gets (#31 blocker 3).
 *
 * Tenant, scope, entitlements, roles, identity pool, and an owner holding
 * `office-admin`. No cast, no fixtures, no second company. Idempotent, so it is
 * safe to call on every start and safe to call against an instance that exists.
 *
 * This is the function an instantiate button calls. `seedDemo` below adds the demo
 * story on top; nothing in the story is reachable from here, which is the point —
 * the separation is enforced by what this function can see, not by discipline.
 */
export async function provisionCallout(
  host: ScopeHost,
  input: { tenantId: TenantId; scopeId: ScopeId; owner: PrincipalId; slug: string; name: string },
): Promise<CalloutInstance> {
  const staff = platformActorId.parse(ulid());

  await host.admin.createTenant(staff, {
    id: input.tenantId,
    slug: input.slug,
    name: input.name,
  });
  // K-23: a provider declares its topology before it may link an identity.
  await host.admin.registerIdentityPool(staff, {
    provider: 'better-auth',
    topology: 'central',
    tenantId: null,
  });
  // Entitlements (§4.3) are default-deny, so the SKU flags for the modules this
  // vertical runs must be granted before any of its operations resolve.
  for (const key of ['workorder', 'invoicing', 'protocol', 'callout']) {
    await host.admin.grantEntitlement(staff, input.tenantId, key);
  }
  await host.provisionScope(staff, {
    tenantId: input.tenantId,
    scopeId: input.scopeId,
    jurisdiction: 'eu',
  });
  // Provisioning writes the row as `provisioning`; nothing may use the scope until
  // it is active (K-31). Here the platform and the vertical are the same process, so
  // the confirmation is immediate — hosted, it arrives from the vertical over a
  // separate call, which is the gap the state exists to make observable.
  await host.admin.activateScope(staff, input.tenantId, input.scopeId);
  for (const role of ROLES) await host.admin.defineRole(staff, input.tenantId, role);
  await host.admin.assignRole(staff, {
    principalId: input.owner,
    roleKey: 'office-admin',
    node: { tenantId: input.tenantId, scopeId: null },
  });

  return { tenantId: input.tenantId, scopeId: input.scopeId, owner: input.owner };
}
