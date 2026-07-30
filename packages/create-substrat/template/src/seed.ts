import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PermissionKey,
  type PrincipalId,
  type RoleDefinition,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { workorderModule, PERM as WO } from '@substrat-run/engine-workorder';
import { invoicingModule, INVOICING_PERM as INV } from '@substrat-run/engine-invoicing';
import { bikeShopModule } from './module.js';
import { SHOP_PERM } from './manifest.js';

// ============================================================================
// The seeded world. TWO tenants on purpose: the first is the shop the scenario
// exercises; the second exists only so the scenario can watch the tenant
// boundary turn its admin away when he reaches across (a cross-tenant attacker
// is the cheapest possible proof that isolation is real).
// ============================================================================

export interface BikeShopWorld {
  t1: TenantId; // the shop under test
  s1: ScopeId; //   its workshop scope
  t2: TenantId; // a second, unrelated shop
  s2: ScopeId; //   its workshop scope
  greta: PrincipalId; // workshop-admin @ t1
  mans: PrincipalId; // mechanic @ t1
  lisbeth: PrincipalId; // portal customer @ t1 (owns a bike)
  otto: PrincipalId; // portal customer @ t1 (owns a different bike)
  rutger: PrincipalId; // workshop-admin @ t2 — the cross-tenant attacker
  lisbethId: string; // customer record ids (filled on first seed)
  ottoId: string;
  crescentId: string; // Lisbeth's bike
  bianchiId: string; // Otto's bike
}

/**
 * The modules this vertical composes, in registration order. Exported so the
 * permission checkpoint (`pnpm lint:permissions`) renders from the same array
 * the running host registers — the artifact can never drift from reality.
 */
export const MODULES = [workorderModule, invoicingModule, bikeShopModule];

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
 * constant the permission snapshot can render without naming a tenant. Exported
 * for the same reason as MODULES.
 */
export const ROLES: RoleDefinition[] = [
  { key: 'workshop-admin', permissions: adminPerms, source: 'vertical' },
  { key: 'mechanic', permissions: [WO.read, WO.report], source: 'vertical' },
];

/** What a portal customer receives, narrowed to their own customer record. */
const portalPerms: PermissionKey[] = [WO.read];

/**
 * Entity-narrowed grant SHAPES. The grants themselves are per-principal and
 * minted at runtime, so they can never be a build artifact; their shape is what
 * tells a reviewer which keys are reachable outside the role table.
 */
export const ENTITY_GRANTS: { entityType: string; permissions: PermissionKey[] }[] = [
  { entityType: 'customer', permissions: portalPerms },
];

export function buildBikeShopHost(dir: string): SqliteScopeHost {
  const host = new SqliteScopeHost({ dir });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/**
 * Provision ONE tenant of this vertical: tenant, entitlements for every module
 * it runs, an active scope, the role table, and the owner holding workshop-admin.
 * This is what an instantiate button would call — no demo cast, no fixtures.
 */
async function provisionShop(
  host: SqliteScopeHost,
  input: { tenantId: TenantId; scopeId: ScopeId; owner: PrincipalId; slug: string; name: string },
): Promise<void> {
  const staff = platformActorId.parse(ulid());
  await host.admin.createTenant(staff, { id: input.tenantId, slug: input.slug, name: input.name });
  // Entitlements are default-deny: the SKU flag for each module this vertical
  // runs must be granted before any of its operations resolve.
  for (const key of ['workorder', 'invoicing', 'bikeshop']) {
    await host.admin.grantEntitlement(staff, input.tenantId, key);
  }
  await host.provisionScope(staff, {
    tenantId: input.tenantId,
    scopeId: input.scopeId,
    jurisdiction: 'global',
  });
  // Provisioning writes the scope as `provisioning`; nothing may use it until it
  // is active (here the platform and the vertical are one process, so the
  // confirmation is immediate).
  await host.admin.activateScope(staff, input.tenantId, input.scopeId);
  for (const role of ROLES) await host.admin.defineRole(staff, input.tenantId, role);
  await host.admin.assignRole(staff, {
    principalId: input.owner,
    roleKey: 'workshop-admin',
    node: { tenantId: input.tenantId, scopeId: null },
  });
}

/**
 * Idempotent seed. Everything that mutates the control plane runs only on a
 * FRESH data dir (guarded by cast.json); on restart the tenants, roles, grants
 * and entities are already in the SQLite files, so we just rebuild the handle
 * object. Safe to call on every server start and on every test.
 */
export async function seedBikeShop(host: SqliteScopeHost, dir: string): Promise<BikeShopWorld> {
  const castPath = join(dir, 'cast.json');
  if (existsSync(castPath)) {
    const raw = JSON.parse(readFileSync(castPath, 'utf8')) as Record<string, string>;
    return {
      t1: tenantId.parse(raw.t1),
      s1: scopeId.parse(raw.s1),
      t2: tenantId.parse(raw.t2),
      s2: scopeId.parse(raw.s2),
      greta: principalId.parse(raw.greta),
      mans: principalId.parse(raw.mans),
      lisbeth: principalId.parse(raw.lisbeth),
      otto: principalId.parse(raw.otto),
      rutger: principalId.parse(raw.rutger),
      lisbethId: raw.lisbethId!,
      ottoId: raw.ottoId!,
      crescentId: raw.crescentId!,
      bianchiId: raw.bianchiId!,
    };
  }

  const staff = platformActorId.parse(ulid());
  const world: BikeShopWorld = {
    t1: tenantId.parse(ulid()),
    s1: scopeId.parse(ulid()),
    t2: tenantId.parse(ulid()),
    s2: scopeId.parse(ulid()),
    greta: principalId.parse(ulid()),
    mans: principalId.parse(ulid()),
    lisbeth: principalId.parse(ulid()),
    otto: principalId.parse(ulid()),
    rutger: principalId.parse(ulid()),
    lisbethId: '',
    ottoId: '',
    crescentId: '',
    bianchiId: '',
  };

  // The shop under test, and a second unrelated shop whose admin will attack it.
  await provisionShop(host, {
    tenantId: world.t1,
    scopeId: world.s1,
    owner: world.greta,
    slug: 'kedja-kugghjul',
    name: 'Kedja & Kugghjul Cykelverkstad',
  });
  await provisionShop(host, {
    tenantId: world.t2,
    scopeId: world.s2,
    owner: world.rutger,
    slug: 'trampolin',
    name: 'Trampolin Cykel',
  });

  // The rest of t1's cast.
  await host.admin.assignRole(staff, {
    principalId: world.mans,
    roleKey: 'mechanic',
    node: { tenantId: world.t1, scopeId: world.s1 },
  });

  // Seed entities go through the operations (NEVER raw SQL): the seed exercises
  // the same permission checks and event spine the app does.
  const greta = await host.getScope(world.greta, world.t1, world.s1);
  const lisbethCustomer = await greta.invoke<{ id: string }>('shop/create-customer', {
    number: '2001',
    name: 'Lisbeth Sandell',
    phone: '070-123 45 67',
  });
  const ottoCustomer = await greta.invoke<{ id: string }>('shop/create-customer', {
    number: '2002',
    name: 'Otto Vinge',
  });
  const crescent = await greta.invoke<{ id: string }>('shop/register-bike', {
    customerId: lisbethCustomer.id,
    label: 'Crescent Elina 3-vxl',
    frameNo: 'CR-88412',
  });
  const bianchi = await greta.invoke<{ id: string }>('shop/register-bike', {
    customerId: ottoCustomer.id,
    label: 'Bianchi Oltre XR3',
  });
  await greta.invoke('shop/upsert-price', {
    article: 'labor',
    description: 'Mechanic time',
    unit: 'hour',
    priceAmount: '495',
    minQty: '0.5',
  });
  await greta.invoke('shop/upsert-price', {
    article: 'shop-supplies',
    description: 'Workshop supplies',
    unit: 'ea',
    priceAmount: '15',
    internal: true,
  });
  await greta.invoke('shop/upsert-price', {
    article: 'tube-28',
    description: 'Inner tube 28"',
    unit: 'ea',
    priceAmount: '89',
  });
  await greta.invoke('shop/upsert-price', {
    article: 'chain-9s',
    description: 'Chain, 9-speed',
    unit: 'ea',
    priceAmount: '249',
  });

  world.lisbethId = lisbethCustomer.id;
  world.ottoId = ottoCustomer.id;
  world.crescentId = crescent.id;
  world.bianchiId = bianchi.id;

  // Portal grants: entity-narrowed per customer (ENTITY_GRANTS). Lisbeth and
  // Otto each hold workorder:read on their OWN customer record only — the walk
  // workorder → bike → customer does the rest.
  for (const [principal, customerId] of [
    [world.lisbeth, world.lisbethId],
    [world.otto, world.ottoId],
  ] as const) {
    for (const permission of portalPerms) {
      await host.admin.grant(staff, {
        principalId: principal,
        permission,
        node: { tenantId: world.t1, scopeId: world.s1 },
        entity: { entityType: 'customer', entityId: customerId },
        grantedBy: world.greta,
      });
    }
  }

  writeFileSync(castPath, JSON.stringify(world, null, 2));
  return world;
}
