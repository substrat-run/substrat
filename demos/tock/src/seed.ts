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
 */
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId, type RoleDefinition } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { TOCK_PERM, tockManifest } from './manifest.js';
import { tockModule } from './module.js';

export const MODULES = [tockModule];

/**
 * Four roles, cumulative, and the cut that matters is between the first two.
 *
 * A viewer reads the counts and never the rows, because the rows carry a pseudonymous subject
 * key and the stored source file carries the addresses it was derived from. Everything above
 * that line differs only in what it may CHANGE.
 */
export const ROLES: RoleDefinition[] = [
  { key: 'viewer', permissions: [TOCK_PERM.reportRead], source: 'vertical' },
  { key: 'analyst', permissions: [TOCK_PERM.reportRead, TOCK_PERM.rowRead, TOCK_PERM.runManage], source: 'vertical' },
  {
    key: 'modeller',
    permissions: [TOCK_PERM.reportRead, TOCK_PERM.rowRead, TOCK_PERM.runManage, TOCK_PERM.schemaManage],
    source: 'vertical',
  },
  /**
   * `admin` holds exactly what `modeller` holds, and the permission artifact says so.
   *
   * Not an oversight and not a role waiting to be collapsed: what separates an admin in the
   * approved concept is managing people, and membership is the platform's invite surface
   * rather than an operation of this vertical. So the distinction is real to a human and
   * invisible to the permission table, which is the honest state of it — merging the two
   * would contradict the design, and inventing a key nobody checks would be worse.
   */
  {
    key: 'admin',
    permissions: [TOCK_PERM.reportRead, TOCK_PERM.rowRead, TOCK_PERM.runManage, TOCK_PERM.schemaManage],
    source: 'vertical',
  },
];

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

export function buildHost(dir: string): ScopeHost {
  const host = new SqliteScopeHost({ dir });
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
