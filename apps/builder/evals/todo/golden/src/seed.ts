/**
 * The world the scenario replays against — harness code, so node imports are fine here.
 * Two tenants; the second exists to be attacked.
 */
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { principalId, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { DEV_PROVIDER, PERSONAS } from './personas.js';
import { ENTITY_GRANTS, OWNER_GRANTS, listsManifest } from './manifest.js';
import { MODULES, ROLES, permissions } from './provision.js';

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
  readonly markus: Person;
  readonly alice: Person;
  readonly bob: Person;
  /** A member who has never signed in, so has not joined: who an invite is for. */
  readonly dana: Person;
  readonly tess: Person;
}

export function buildHost(dir: string): ScopeHost {
  const host = new SqliteScopeHost({ dir, permissions });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

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
    markus: person('Markus', 'markus@example.com'),
    alice: person('Alice', 'alice@example.com'),
    bob: person('Bob', 'bob@example.com'),
    dana: person('Dana', 'dana@example.com'),
    tess: person('Tess', 'tess@example.com'),
  };

  for (const [t, s, people] of [
    [world.tenant, world.scope, [world.markus, world.alice, world.bob, world.dana]],
    [world.otherTenant, world.otherScope, [world.tess]],
  ] as const) {
    await host.admin.createTenant(world.staff, {
      id: t,
      slug: `lists-${t.slice(-6).toLowerCase()}`,
      name: 'Shared Lists',
    });
    await host.admin.grantEntitlement(world.staff, t, listsManifest.entitlementKey as string);
    await host.provisionScope(world.staff, { tenantId: t, scopeId: s, vertical: 'shared-lists' });
    await host.admin.activateScope(world.staff, t, s);
    for (const role of ROLES) await host.admin.defineRole(world.staff, t, role);

    for (const p of people) {
      await host.admin.assignRole(world.staff, {
        principalId: p.principal,
        roleKey: 'list-member',
        node: { tenantId: t, scopeId: s },
      });
      if (p === world.dana) continue;
      const stub = await host.getScope(p.principal, t, s);
      await stub.invoke('lists/join', { email: p.email, displayName: p.name });
      await grantOwner(host, world.staff, { tenantId: t, scopeId: s }, p.principal);
    }
  }
  return world;
}

/** The bootstrap grant: rights over your OWN person entity, which your lists hang off. */
export async function grantOwner(
  host: ScopeHost,
  staff: ReturnType<typeof platformActorId.parse>,
  node: { tenantId: ReturnType<typeof tenantId.parse>; scopeId: ReturnType<typeof scopeId.parse> },
  principal: ReturnType<typeof principalId.parse>,
): Promise<void> {
  await host.admin.grantEntityShape(staff, {
    principalId: principal,
    node,
    entity: { entityType: 'person', entityId: principal },
    permissions: OWNER_GRANTS,
    grantedBy: principal,
  });
}

export async function reconcileOwnerGrants(host: ScopeHost, world: World): Promise<void> {
  for (const [tenantId, scopeId] of [
    [world.tenant, world.scope],
    [world.otherTenant, world.otherScope],
  ] as const) {
    await host.admin.reconcileEntityGrantShapes(world.staff, { tenantId, scopeId }, ENTITY_GRANTS);
  }
}

/** Bind each dev persona's OIDC `sub` to its principal, on every boot. */
export async function linkDevPersonas(host: ScopeHost, world: World): Promise<void> {
  await host.admin.registerIdentityPool(world.staff, {
    provider: DEV_PROVIDER,
    topology: 'central',
    tenantId: null,
  });
  const homes: Record<string, { person: Person; tenant: typeof world.tenant; scope: typeof world.scope }> = {
    'dev|markus': { person: world.markus, tenant: world.tenant, scope: world.scope },
    'dev|alice': { person: world.alice, tenant: world.tenant, scope: world.scope },
    'dev|bob': { person: world.bob, tenant: world.tenant, scope: world.scope },
    'dev|dana': { person: world.dana, tenant: world.tenant, scope: world.scope },
    'dev|tess': { person: world.tess, tenant: world.otherTenant, scope: world.otherScope },
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
