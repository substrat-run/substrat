/**
 * The world the scenario replays against — harness code, so `node:*` is fine here and never
 * in module code.
 *
 * Two publishers, always. The second exists to be attacked: isolation you can only describe
 * is isolation you have not proved. Petra is a legitimate admin of her own workspace and a
 * nobody in the other, which is the only honest way to test a denial — a principal with no
 * rights anywhere proves nothing.
 *
 * Roles are the whole of the permission story here. Unlike a record app there is no
 * entity-narrowed bootstrap grant to make: every permission in this vertical is held
 * workspace-wide or not at all, because a run belongs to the workspace rather than to the
 * person who uploaded it.
 *
 * `MODULES` and `ROLES` come FROM `provision.ts` and are re-exported here for the scenario's
 * convenience. The direction is the point: this file imports an adapter, so declaring them
 * here would put one behind the permission checkpoint's import.
 */
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, type Clock, type ScopeHost } from '@substrat-run/kernel';
import { tockManifest } from './manifest.js';
import { MODULES, ROLES } from './provision.js';
import { DEV_PROVIDER, PERSONAS } from './personas.js';

export { MODULES, ROLES };

export interface Person {
  readonly name: string;
  readonly role: string;
  readonly principal: ReturnType<typeof principalId.parse>;
}

export interface World {
  readonly staff: ReturnType<typeof platformActorId.parse>;
  readonly tenant: ReturnType<typeof tenantId.parse>;
  readonly scope: ReturnType<typeof scopeId.parse>;
  readonly otherTenant: ReturnType<typeof tenantId.parse>;
  readonly otherScope: ReturnType<typeof scopeId.parse>;
  /** admin at the first publisher */
  readonly ines: Person;
  /** analyst — uploads and runs the lifecycle, may not write a schema */
  readonly tomas: Person;
  /** viewer — reads counts, never rows */
  readonly wren: Person;
  /** admin at the second publisher, and a nobody at the first */
  readonly petra: Person;
}

/**
 * `clock` is what lets a scenario put two runs inside one instant.
 *
 * Not a convenience: "the latest counted run wins" is a claim about ordering, and the only
 * honest way to test what happens when two of them tie is to hand the host a clock that ties
 * them. Defaulted to the wall clock, so every other caller is unaffected.
 */
export function buildHost(dir: string, clock?: Clock): ScopeHost {
  const host = new SqliteScopeHost({ dir, ...(clock ? { clock } : {}) });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/** Principal ids are ULID-minted; readability lives in `name`, never in the id. */
const person = (name: string, role: string): Person => ({
  name,
  role,
  principal: principalId.parse(ulid()),
});

export async function seed(host: ScopeHost): Promise<World> {
  const world: World = {
    staff: platformActorId.parse(ulid()),
    tenant: tenantId.parse(ulid()),
    scope: scopeId.parse(ulid()),
    otherTenant: tenantId.parse(ulid()),
    otherScope: scopeId.parse(ulid()),
    ines: person('Ines Delgado', 'admin'),
    tomas: person('Tomas Reuter', 'analyst'),
    wren: person('Wren Okafor', 'viewer'),
    petra: person('Petra Halvorsen', 'admin'),
  };

  for (const [t, s, people] of [
    [world.tenant, world.scope, [world.ines, world.tomas, world.wren]],
    [world.otherTenant, world.otherScope, [world.petra]],
  ] as const) {
    await host.admin.createTenant(world.staff, {
      id: t,
      slug: `tock-${t.slice(-6).toLowerCase()}`,
      name: 'Tock',
    });
    await host.admin.grantEntitlement(world.staff, t, tockManifest.entitlementKey as string);
    await host.provisionScope(world.staff, { tenantId: t, scopeId: s, vertical: 'tock' });
    await host.admin.activateScope(world.staff, t, s);
    for (const role of ROLES) await host.admin.defineRole(world.staff, t, role);

    for (const p of people) {
      await host.admin.assignRole(world.staff, {
        principalId: p.principal,
        roleKey: p.role,
        node: { tenantId: t, scopeId: s },
      });
    }
  }

  return world;
}

/**
 * Bind each dev persona's OIDC `sub` to its principal — the ordinary identity-directory seam.
 *
 * Run on every boot rather than only on a fresh seed, because the world is cached in
 * `cast.json` and `seed()` does not run again once it exists. `linkIdentity` is idempotent for
 * an unchanged binding, so re-running costs nothing and a wiped `.data` heals itself.
 *
 * Petra's home is the OTHER workspace, and that is the whole of what makes her a nobody at
 * Fjord: the directory decides which tenant a login lands in, so nothing in the API layer has
 * to know she is special.
 */
export async function linkDevPersonas(host: ScopeHost, world: World): Promise<void> {
  await host.admin.registerIdentityPool(world.staff, { provider: DEV_PROVIDER, topology: 'central', tenantId: null });
  const homes: Record<string, { person: Person; tenant: typeof world.tenant; scope: typeof world.scope }> = {
    'dev|ines': { person: world.ines, tenant: world.tenant, scope: world.scope },
    'dev|tomas': { person: world.tomas, tenant: world.tenant, scope: world.scope },
    'dev|wren': { person: world.wren, tenant: world.tenant, scope: world.scope },
    'dev|petra': { person: world.petra, tenant: world.otherTenant, scope: world.otherScope },
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
