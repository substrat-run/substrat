/**
 * The world the scenario replays against — harness code, so `node:*` is fine
 * here and never in module code.
 *
 * Two tenants, always. The second exists to be attacked: isolation you can only
 * describe is isolation you have not proved.
 *
 * The only thing seeded that an operation could not do itself is the GRANT on a
 * person's own entity. That is deliberate — it is a platform actor's act (you do
 * not grant yourself your own account), and it is the bootstrap that everything
 * else delegates from: the owner reaches their lists through it, and `ctx.grant`
 * can only ever hand out what it finds there.
 */
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { DEV_PROVIDER, PERSONAS } from './personas.js';
import {
  principalId,
  platformActorId,
  scopeId,
  tenantId,
} from '@substrat-run/contracts';
import { seatWorld, ulid, type ScopeHost, type WorldSeat } from '@substrat-run/kernel';
import { ENTITY_GRANTS, OWNER_GRANTS, todoManifest } from './manifest.js';
import { MODULES, ROLES, permissions } from './provision.js';
import { WORLD } from './world.js';

export { MODULES, ROLES };

export interface Person {
  readonly name: string;
  readonly email: string;
  readonly principal: ReturnType<typeof principalId.parse>;
}

export interface World {
  readonly staff: ReturnType<typeof platformActorId.parse>;
  readonly tenant: ReturnType<typeof tenantId.parse>;
  readonly scope: ReturnType<typeof scopeId.parse>;
  readonly otherTenant: ReturnType<typeof tenantId.parse>;
  readonly otherScope: ReturnType<typeof scopeId.parse>;
  readonly ada: Person;
  readonly bjorn: Person;
  readonly cleo: Person;
}

export function buildHost(dir: string): ScopeHost {
  const host = new SqliteScopeHost({ dir, permissions });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/**
 * Provision both tenants, then let the kernel seat the cast in each: `WORLD` (`./world.ts`)
 * says who is where and what they start with, and `seatWorld` gives each persona a principal,
 * its role and its identity link — the same function a hosted seeded preview runs (#3108).
 */
export async function seed(host: ScopeHost): Promise<World> {
  const staff = platformActorId.parse(ulid());
  const homes = {
    home: { tenantId: tenantId.parse(ulid()), scopeId: scopeId.parse(ulid()) },
    elsewhere: { tenantId: tenantId.parse(ulid()), scopeId: scopeId.parse(ulid()) },
  } as const;
  await host.admin.registerIdentityPool(staff, { provider: DEV_PROVIDER, topology: 'central', tenantId: null });

  const seats = new Map<string, WorldSeat>();
  for (const seat of ['home', 'elsewhere'] as const) {
    const { tenantId: t, scopeId: s } = homes[seat];
    await host.admin.createTenant(staff, { id: t, slug: `todo-${t.slice(-6).toLowerCase()}`, name: 'Todo' });
    await host.admin.grantEntitlement(staff, t, todoManifest.entitlementKey as string);
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'todo' });
    await host.admin.activateScope(staff, t, s);
    for (const role of ROLES) await host.admin.defineRole(staff, t, role);
    const seated = await seatWorld(host, { actor: staff, node: homes[seat], provider: DEV_PROVIDER, world: WORLD, seat, build: true });
    for (const [sub, at] of seated) seats.set(sub, at);
  }

  const person = (sub: string): Person => {
    const persona = PERSONAS.find((p) => p.sub === sub);
    const at = seats.get(sub);
    if (!persona || !at) throw new Error(`todo seed: persona ${sub} was not seated`);
    return { name: persona.name, email: persona.email, principal: at.principal };
  };
  return {
    staff,
    tenant: homes.home.tenantId,
    scope: homes.home.scopeId,
    otherTenant: homes.elsewhere.tenantId,
    otherScope: homes.elsewhere.scopeId,
    ada: person('dev|ada'),
    bjorn: person('dev|bjorn'),
    cleo: person('dev|cleo'),
  };
}

/**
 * The bootstrap grant: rights over your OWN entity, which your lists then hang off. Nobody
 * holds these scope-wide, which is what keeps one member's lists unreachable to another.
 *
 * Granted as the declared SHAPE (#2071) — `OWNER_GRANTS`, the `owner` row of `ENTITY_GRANTS` and the same list `PERMISSIONS.md` shows a
 * reviewer — so the person is marked as holding it, and a key added to it later reaches them
 * at the next {@link reconcileOwnerGrants}, which the dev server runs on every boot.
 */
export async function grantOwner(
  host: ScopeHost,
  staff: ReturnType<typeof platformActorId.parse>,
  node: { tenantId: ReturnType<typeof tenantId.parse>; scopeId: ReturnType<typeof scopeId.parse> },
  principal: ReturnType<typeof principalId.parse>,
): Promise<void> {
  await host.admin.grantEntityShape(staff, {
    principalId: principal,
    node,
    entity: { entityType: 'owner', entityId: principal },
    permissions: OWNER_GRANTS,
    grantedBy: principal,
  });
}

/**
 * Top every owner up to the `owner` shape as it is now (#2071), in both seeded scopes: a world
 * seeded before a key was added to the shape receives it, exactly as a deployed install's
 * reconcile does. Idempotent, so running it on every boot costs a no-op.
 */
export async function reconcileOwnerGrants(host: ScopeHost, world: World): Promise<void> {
  for (const [tenantId, scopeId] of [
    [world.tenant, world.scope],
    [world.otherTenant, world.otherScope],
  ] as const) {
    await host.admin.reconcileEntityGrantShapes(world.staff, { tenantId, scopeId }, ENTITY_GRANTS);
  }
}

/**
 * Seat the cast again on every boot, because the world is cached in `cast.json` and `seed()`
 * does not run again once it exists. Seating is idempotent — a persona already linked keeps its
 * principal — so this costs nothing, a wiped `.data` heals itself, and a persona added to
 * `personas.ts` after the first boot gets a principal, a role and a link (but no `build`: that
 * runs only on a fresh world).
 */
export async function linkDevPersonas(host: ScopeHost, world: World): Promise<void> {
  await host.admin.registerIdentityPool(world.staff, { provider: DEV_PROVIDER, topology: 'central', tenantId: null });
  for (const [seat, node] of [
    ['home', { tenantId: world.tenant, scopeId: world.scope }],
    ['elsewhere', { tenantId: world.otherTenant, scopeId: world.otherScope }],
  ] as const) {
    await seatWorld(host, { actor: world.staff, node, provider: DEV_PROVIDER, world: WORLD, seat });
  }
}
