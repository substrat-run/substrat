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
  type RoleDefinition,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { ENTITY_GRANTS, OWNER_GRANTS, TODO_PERM, todoManifest } from './manifest.js';
import { todoModule } from './module.js';

export const MODULES = [todoModule];

export const ROLES: RoleDefinition[] = [
  { key: 'member', permissions: [TODO_PERM.listCreate], source: 'vertical' },
];

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
  const host = new SqliteScopeHost({ dir });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/** Principal ids are ULID-minted; readability lives in `name`, never in the id. */
const person = (name: string, email: string): Person => ({
  name,
  email,
  principal: principalId.parse(ulid()),
});

export async function seed(host: ScopeHost): Promise<World> {
  const world: World = {
    staff: platformActorId.parse(ulid()),
    tenant: tenantId.parse(ulid()),
    scope: scopeId.parse(ulid()),
    otherTenant: tenantId.parse(ulid()),
    otherScope: scopeId.parse(ulid()),
    ada: person('Ada', 'ada@example.com'),
    bjorn: person('Björn', 'bjorn@example.com'),
    cleo: person('Cleo', 'cleo@example.com'),
  };

  for (const [t, s, people] of [
    [world.tenant, world.scope, [world.ada, world.bjorn]],
    [world.otherTenant, world.otherScope, [world.cleo]],
  ] as const) {
    await host.admin.createTenant(world.staff, { id: t, slug: `todo-${t.slice(-6).toLowerCase()}`, name: 'Todo' });
    await host.admin.grantEntitlement(world.staff, t, todoManifest.entitlementKey as string);
    await host.provisionScope(world.staff, { tenantId: t, scopeId: s, vertical: 'todo' });
    await host.admin.activateScope(world.staff, t, s);
    for (const role of ROLES) await host.admin.defineRole(world.staff, t, role);

    for (const p of people) {
      await host.admin.assignRole(world.staff, {
        principalId: p.principal,
        roleKey: 'member',
        node: { tenantId: t, scopeId: s },
      });
      // Claim the account through the operation — never a raw INSERT from here.
      const stub = await host.getScope(p.principal, t, s);
      await stub.invoke('todo/join', { email: p.email, displayName: p.name });

      await grantOwner(host, world.staff, { tenantId: t, scopeId: s }, p.principal);
    }
  }

  return world;
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
 * Bind each dev persona's OIDC `sub` to its principal — the ordinary identity-directory
 * seam, run on every boot rather than only on a fresh seed, because the world is cached in
 * `cast.json` and `seed()` does not run again once it exists. `linkIdentity` is idempotent
 * for an unchanged binding, so re-running costs nothing and a wiped `.data` heals itself.
 */
export async function linkDevPersonas(host: ScopeHost, world: World): Promise<void> {
  await host.admin.registerIdentityPool(world.staff, { provider: DEV_PROVIDER, topology: 'central', tenantId: null });
  const homes: Record<string, { person: Person; tenant: typeof world.tenant; scope: typeof world.scope }> = {
    'dev|ada': { person: world.ada, tenant: world.tenant, scope: world.scope },
    'dev|bjorn': { person: world.bjorn, tenant: world.tenant, scope: world.scope },
    'dev|cleo': { person: world.cleo, tenant: world.otherTenant, scope: world.otherScope },
  };
  for (const persona of PERSONAS) {
    const home = homes[persona.sub];
    if (!home) continue;
    await host.admin.linkIdentity(world.staff, {
      provider: DEV_PROVIDER,
      externalId: persona.sub,
      principal: home.person.principal,
      tenantId: home.tenant,
      scopeId: home.scope,
    });
  }
}
