import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  definePermissions,
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
import { invoicingModule, INVOICING_PERM as INV } from '@substrat-run/engine-invoicing';
import { shopModule, SHOP_PERM } from './module.js';

/**
 * What ANY instance of this vertical has: one tenant, one scope, an owner.
 *
 * The boundary #31 blocker 3 is about. Everything in ShopWorld beyond these three is
 * the DEMO STORY, and a customer who instantiates the template must not receive
 * it. Separate types make that structural: `provisionShop` cannot return a cast,
 * because its return type has no room for one.
 */
export interface ShopInstance {
  tenantId: TenantId;
  scopeId: ScopeId;
  /** The first shop-admin — whoever provisioned it. */
  owner: PrincipalId;
}

/** The demo world: an instance, plus the cast and fixtures the story needs. */
export interface ShopWorld extends ShopInstance {
  t1: TenantId; // Kallkälla Kaffe AB
  t2: TenantId; // Bönfeber Rosteri AB (the attack victim owner)
  s1: ScopeId; // Kallkälla web shop
  s2: ScopeId; // Bönfeber web shop
  astrid: PrincipalId; // shop-admin (tenant-level)
  gustav: PrincipalId; // warehouse @ s1
  elin: PrincipalId; // customer-shopper (Café Pascal)
  otto: PrincipalId; // customer-shopper (Kontoret Otto)
  guest: PrincipalId; // anonymous shopper — no order grant
  public: PrincipalId; // browse-only fallback for not-logged-in visitors
  rurik: PrincipalId; // shop-admin @ t2 — the attacker
  elinCustomerId?: string;
  ottoCustomerId?: string;
  microLotVariantId?: string; // Gichichi AA 250 g — on_hand 1 (the oversell beat)
  chelbesaVariantId?: string; // Chelbesa 250 g — the TTL-release beat
}

/**
 * The modules this vertical composes, in registration order. Exported because
 * `tools/permission-diff.mts` renders the permission checkpoint from this same
 * array — the emitter and the running host read the one object, so the artifact
 * cannot drift from what is actually registered.
 */
export const MODULES = [invoicingModule, shopModule];

const adminPerms = [
  SHOP_PERM.catalogManage, SHOP_PERM.stockManage, SHOP_PERM.discountManage,
  SHOP_PERM.customerManage, SHOP_PERM.orderRead, SHOP_PERM.orderFulfil,
  SHOP_PERM.browse, SHOP_PERM.checkout,
  INV.read, INV.export,
];

/**
 * This vertical's role table — identical in every tenant, which is why it is a
 * plain constant and why the permission snapshot can render it without naming a
 * tenant. Per-tenant customisation is a console concern (runtime), not a
 * build-time one. Exported for the same reason as MODULES.
 */
export const ROLES: RoleDefinition[] = [
  { key: 'shop-admin', permissions: adminPerms, source: 'vertical' },
  {
    key: 'warehouse',
    permissions: [SHOP_PERM.stockManage, SHOP_PERM.orderFulfil, SHOP_PERM.orderRead, SHOP_PERM.browse],
    source: 'vertical',
  },
  { key: 'shopper', permissions: [SHOP_PERM.browse, SHOP_PERM.checkout], source: 'vertical' },
  // Anonymous visitors: read the catalogue only. Not an auth bypass — a
  // principal holding a thin role, checked on the same code path as every other.
  { key: 'public', permissions: [SHOP_PERM.browse], source: 'vertical' },
];

/** What a portal customer receives, narrowed to their own customer record. */
const portalPerms = [SHOP_PERM.orderRead];

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

export function buildShopHost(dir: string): SqliteScopeHost {
  const host = new SqliteScopeHost({ dir });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/** Idempotent: safe on every server start; demo data seeds only once. */
/**
 * The identity provider for one storefront. Per instance, because the pool is
 * tenant-bound and a provider string names exactly one pool (K-23).
 */
export const shopProvider = (slug: string): string => `better-auth:${slug}`;

/**
 * Provision ONE instance of this vertical — what a customer gets (#31 blocker 3).
 *
 * Tenant, scope, entitlements, roles, identity pool, and an owner holding
 * `shop-admin`. No cast, no fixtures, no second company. Idempotent, so it is
 * safe on every start and safe against an instance that already exists.
 *
 * This is the function an instantiate button calls.
 */
export async function provisionShop(
  host: SqliteScopeHost,
  input: { tenantId: TenantId; scopeId: ScopeId; owner: PrincipalId; slug: string; name: string },
): Promise<ShopInstance> {
  const staff = platformActorId.parse(ulid());

  await host.admin.createTenant(staff, { id: input.tenantId, slug: input.slug, name: input.name });
  // K-23: a provider declares its topology before it may link an identity.
  //
  // TENANT-BOUND here, unlike the other templates: a white-label storefront is
  // the case §4.3 reserves it for — a shopper at two shops is correctly two
  // accounts, and the shop must never learn the platform exists.
  //
  // Which forces a per-instance provider string. A provider names exactly ONE
  // pool, so two tenant-bound instances both calling themselves `better-auth`
  // would collide on the second registration. `shopProvider` derives it from the
  // slug — the same rule K-23 states for separate per-tenant deployments.
  await host.admin.registerIdentityPool(staff, {
    provider: shopProvider(input.slug),
    topology: 'tenant-bound',
    tenantId: input.tenantId,
  });
  // Entitlements (§4.3) are default-deny, so the SKU flags for the modules this
  // vertical runs must be granted before any of its operations resolve.
  for (const key of ['invoicing', 'shop']) {
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
    roleKey: 'shop-admin',
    node: { tenantId: input.tenantId, scopeId: null },
  });

  return { tenantId: input.tenantId, scopeId: input.scopeId, owner: input.owner };
}

export async function seedShop(host: SqliteScopeHost, dir: string): Promise<ShopWorld> {
  const castPath = join(dir, 'cast.json');
  const fresh = !existsSync(castPath);
  const raw: Record<string, string> = fresh
    ? {
        t1: ulid(), t2: ulid(), s1: ulid(), s2: ulid(),
        astrid: ulid(), gustav: ulid(), elin: ulid(), otto: ulid(), guest: ulid(),
        public: ulid(), rurik: ulid(),
        elinCustomerId: '', ottoCustomerId: '', microLotVariantId: '', chelbesaVariantId: '',
      }
    : (JSON.parse(readFileSync(castPath, 'utf8')) as Record<string, string>);

  const world: ShopWorld = {
    tenantId: tenantId.parse(raw.t1),
    scopeId: scopeId.parse(raw.s1),
    owner: principalId.parse(raw.astrid),
    t1: tenantId.parse(raw.t1), t2: tenantId.parse(raw.t2),
    s1: scopeId.parse(raw.s1), s2: scopeId.parse(raw.s2),
    astrid: principalId.parse(raw.astrid), gustav: principalId.parse(raw.gustav),
    elin: principalId.parse(raw.elin), otto: principalId.parse(raw.otto),
    guest: principalId.parse(raw.guest),
    // Tolerant of a cast.json written before `public` existed — anonymous browse
    // is stateless, so a fresh id per start is fine.
    public: principalId.parse(raw.public ?? ulid()),
    rurik: principalId.parse(raw.rurik),
    elinCustomerId: raw.elinCustomerId ?? '', ottoCustomerId: raw.ottoCustomerId ?? '',
    microLotVariantId: raw.microLotVariantId ?? '', chelbesaVariantId: raw.chelbesaVariantId ?? '',
  };

  const staff = platformActorId.parse(ulid());

  // The real instance — everything a customer would get, and nothing else.
  await provisionShop(host, {
    tenantId: world.t1,
    scopeId: world.s1,
    owner: world.astrid,
    slug: 'kallkalla',
    name: 'Kallkälla Kaffe AB',
  });

  // ---------------------------------------------------------------------------
  // DEMO ONLY, below. A second roastery and an admin nobody hired, so the
  // scenario can watch the tenant boundary turn them away (#31 blocker 4). Never
  // reachable from provisioning: instantiating the template would otherwise hand
  // a customer a company they do not own with an admin account they did not
  // create — and since #71 that account has a working login.
  // ---------------------------------------------------------------------------
  await provisionShop(host, {
    tenantId: world.t2,
    scopeId: world.s2,
    owner: world.rurik,
    slug: 'bonfeber',
    name: 'Bönfeber Rosteri AB',
  });

  // The demo cast's remaining roles; the tenant-level admins came from provisioning.
  await host.admin.assignRole(staff, { principalId: world.gustav, roleKey: 'warehouse', node: { tenantId: world.t1, scopeId: world.s1 } });
  await host.admin.assignRole(staff, { principalId: world.elin, roleKey: 'shopper', node: { tenantId: world.t1, scopeId: world.s1 } });
  await host.admin.assignRole(staff, { principalId: world.otto, roleKey: 'shopper', node: { tenantId: world.t1, scopeId: world.s1 } });
  await host.admin.assignRole(staff, { principalId: world.guest, roleKey: 'shopper', node: { tenantId: world.t1, scopeId: world.s1 } });
  await host.admin.assignRole(staff, { principalId: world.public, roleKey: 'public', node: { tenantId: world.t1, scopeId: world.s1 } });

  if (fresh) {
    const stub = await host.getScope(world.astrid, world.t1, world.s1);

    const gichichi = await stub.invoke<{ id: string }>('shop/create-product', {
      slug: 'gichichi-aa', name: 'Gichichi AA', origin: 'Kenya · Nyeri',
      notes: 'Svarta vinbär, blodgrapefrukt, rabarber.', roast: 1,
    });
    const microLot = await stub.invoke<{ id: string }>('shop/add-variant', {
      productId: gichichi.id, sku: 'GICH-250-HB', grind: 'Hela bönor', sizeLabel: '250 g', priceAmount: '189',
    });
    await stub.invoke('shop/set-stock', { variantId: microLot.id, onHand: 1 }); // the micro-lot
    await stub.invoke('shop/publish-product', { productId: gichichi.id });

    const chelbesa = await stub.invoke<{ id: string }>('shop/create-product', {
      slug: 'chelbesa', name: 'Chelbesa', origin: 'Etiopien · Gedeb',
      notes: 'Jasmin, persika, bergamott.', roast: 1,
    });
    const chelbesaVariant = await stub.invoke<{ id: string }>('shop/add-variant', {
      productId: chelbesa.id, sku: 'CHEL-250-HB', grind: 'Hela bönor', sizeLabel: '250 g', priceAmount: '165',
    });
    await stub.invoke('shop/set-stock', { variantId: chelbesaVariant.id, onHand: 20 });
    await stub.invoke('shop/publish-product', { productId: chelbesa.id });

    await stub.invoke('shop/create-discount', { code: 'KALLKALLA10', kind: 'pct', value: '10', uses: 100 });

    const elinCustomer = await stub.invoke<{ id: string }>('shop/create-customer', {
      number: 'K-100', name: 'Café Pascal', orgRef: 'org:cafe-pascal',
    });
    const ottoCustomer = await stub.invoke<{ id: string }>('shop/create-customer', {
      number: 'K-101', name: 'Kontoret Otto AB',
    });

    world.elinCustomerId = elinCustomer.id;
    world.ottoCustomerId = ottoCustomer.id;
    world.microLotVariantId = microLot.id;
    world.chelbesaVariantId = chelbesaVariant.id;
    writeFileSync(castPath, JSON.stringify(world, null, 2));
  }

  // Portal grants (idempotent): entity-narrowed per customer — see ENTITY_GRANTS.
  for (const [principal, customerId] of [
    [world.elin, world.elinCustomerId],
    [world.otto, world.ottoCustomerId],
  ] as const) {
    if (!customerId) continue;
    for (const permission of portalPerms) {
      await host.admin.grant(staff, {
        principalId: principal, permission,
        node: { tenantId: world.t1, scopeId: world.s1 },
        entity: { entityType: 'customer', entityId: customerId },
        grantedBy: world.astrid,
      });
    }
  }

  return world;
}
