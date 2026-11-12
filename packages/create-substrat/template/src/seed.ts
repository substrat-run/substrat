import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { seatWorld, ulid, type WorldSeat } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { defaultAttachmentExtractors } from '@substrat-run/attachment-extractors';
import { ENTITLEMENT_KEYS, ENTITY_GRANTS, MODULES, permissions, portalPerms, ROLES } from './provision.js';

// The provisioning surface (modules, roles, grant shapes) lives in
// provision.ts — node-free so the worker bundles it and `substrat push` reads
// it. Re-exported here for callers that treat seed.ts as the world's front door.
export { ENTITY_GRANTS, MODULES, permissions, ROLES } from './provision.js';
import { DEV_PROVIDER } from './personas.js';
import { buildShop, WORLD, type ShopRecords } from './world.js';

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

export function buildBikeShopHost(dir: string): SqliteScopeHost {
  const host = new SqliteScopeHost({ dir, attachmentExtractors: defaultAttachmentExtractors(), permissions });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/**
 * Provision ONE tenant of this vertical: tenant, entitlements for every module it runs, an
 * active scope, and the role table. This is what an instantiate button would call — no demo
 * cast, no fixtures. The people come after, from `src/world.ts`.
 */
async function provisionShop(
  host: SqliteScopeHost,
  input: { tenantId: TenantId; scopeId: ScopeId; slug: string; name: string },
): Promise<void> {
  const staff = platformActorId.parse(ulid());
  await host.admin.createTenant(staff, { id: input.tenantId, slug: input.slug, name: input.name });
  // Entitlements are default-deny: the SKU flag for each module this vertical
  // runs must be granted before any of its operations resolve.
  for (const key of ENTITLEMENT_KEYS) {
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
}

/**
 * Idempotent seed. Everything that mutates the control plane runs only on a
 * FRESH data dir (guarded by cast.json); on restart the tenants, roles, grants
 * and entities are already in the SQLite files, so we just rebuild the handle
 * object — and re-apply the portal grants, which are idempotent. Safe to call
 * on every server start and on every test.
 */
export async function seedBikeShop(host: SqliteScopeHost, dir: string): Promise<BikeShopWorld> {
  const castPath = join(dir, 'cast.json');
  if (existsSync(castPath)) {
    const raw = JSON.parse(readFileSync(castPath, 'utf8')) as Record<string, string>;
    const world: BikeShopWorld = {
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
    await grantPortals(host, world);
    return world;
  }

  const homes = {
    home: { tenantId: tenantId.parse(ulid()), scopeId: scopeId.parse(ulid()) },
    elsewhere: { tenantId: tenantId.parse(ulid()), scopeId: scopeId.parse(ulid()) },
  } as const;
  // The shop under test, and a second unrelated shop whose admin will attack it.
  await provisionShop(host, { ...homes.home, slug: 'kedja-kugghjul', name: 'Kedja & Kugghjul Cykelverkstad' });
  await provisionShop(host, { ...homes.elsewhere, slug: 'trampolin', name: 'Trampolin Cykel' });

  // The cast and the records they start with: `src/world.ts`, seated by the kernel in each
  // shop — a principal per persona, its role, its identity link — the same way a seeded
  // preview of the deployed app seats it. Its records are kept for `cast.json`.
  const staff = platformActorId.parse(ulid());
  await host.admin.registerIdentityPool(staff, { provider: DEV_PROVIDER, topology: 'central', tenantId: null });
  let records: ShopRecords | null = null;
  const seats = new Map<string, WorldSeat>();
  for (const seat of ['home', 'elsewhere'] as const) {
    const seated = await seatWorld(host, {
      actor: staff,
      node: homes[seat],
      provider: DEV_PROVIDER,
      world: { ...WORLD, build: async (w) => void (records ??= await buildShop(w)) },
      seat,
      build: true,
    });
    for (const [sub, at] of seated) seats.set(sub, at);
  }
  const principalOf = (sub: string): PrincipalId => {
    const at = seats.get(sub);
    if (!at) throw new Error(`seed: persona ${sub} was not seated`);
    return at.principal;
  };
  if (!records) throw new Error('seed: the shop under test was built with no records');
  const world: BikeShopWorld = {
    t1: homes.home.tenantId,
    s1: homes.home.scopeId,
    t2: homes.elsewhere.tenantId,
    s2: homes.elsewhere.scopeId,
    greta: principalOf('dev|greta'),
    mans: principalOf('dev|mans'),
    lisbeth: principalOf('dev|lisbeth'),
    otto: principalOf('dev|otto'),
    rutger: principalOf('dev|rutger'),
    ...(records as ShopRecords),
  };
  // `buildShop` gave the portal grants; the reconcile tops every holder up to the shape as it is.
  await host.admin.reconcileEntityGrantShapes(staff, homes.home, ENTITY_GRANTS);

  writeFileSync(castPath, JSON.stringify(world, null, 2));
  return world;
}

/**
 * Portal grants: the `customer` shape (ENTITY_GRANTS) on each customer's own
 * record. Lisbeth and Otto each hold workorder:read on their OWN customer
 * record only — the walk workorder → bike → customer does the rest.
 *
 * Given as the SHAPE, so a key you add to `portalPerms` later reaches them,
 * and then topped up to the shape as it is now, which is what the platform's
 * reconcile does for a deployed install. Both are idempotent, so this runs on
 * every boot, and a world seeded before you added a key receives it.
 */
async function grantPortals(host: SqliteScopeHost, world: BikeShopWorld): Promise<void> {
  const staff = platformActorId.parse(ulid());
  const node = { tenantId: world.t1, scopeId: world.s1 };
  for (const [principal, customerId] of [
    [world.lisbeth, world.lisbethId],
    [world.otto, world.ottoId],
  ] as const) {
    await host.admin.grantEntityShape(staff, {
      principalId: principal,
      node,
      entity: { entityType: 'customer', entityId: customerId },
      permissions: portalPerms,
      grantedBy: world.greta,
    });
  }
  await host.admin.reconcileEntityGrantShapes(staff, node, ENTITY_GRANTS);
}

/**
 * Seat the cast again on every boot, because `seedBikeShop` returns early once `cast.json`
 * exists. Seating is idempotent — a persona already linked keeps its principal — so this costs
 * nothing, a wiped identity link heals itself, and a persona added to `src/personas.ts` after
 * the first boot gets a principal, its role and a link (but no records: `build` runs only on a
 * fresh world).
 *
 * This is the ordinary production seam, not a dev one: a deployed instance builds the same rows
 * when someone claims the owner seat or accepts an invite, and a seeded preview runs this very
 * seating. All that differs locally is that the subjects are known up front.
 */
export async function linkDevPersonas(host: SqliteScopeHost, world: BikeShopWorld): Promise<void> {
  const staff = platformActorId.parse(ulid());
  await host.admin.registerIdentityPool(staff, { provider: DEV_PROVIDER, topology: 'central', tenantId: null });
  for (const [seat, node] of [
    ['home', { tenantId: world.t1, scopeId: world.s1 }],
    ['elsewhere', { tenantId: world.t2, scopeId: world.s2 }],
  ] as const) {
    await seatWorld(host, { actor: staff, node, provider: DEV_PROVIDER, world: WORLD, seat });
  }
}
