/**
 * The pair the plugin runs in — harness code, so `node:*` is fine here and never in module code.
 *
 * Two verticals, each on its own host, as each is its own deployment in production: Todo with
 * its seeded cast, and Notes installed in the SAME tenant with nobody in it. The local broker
 * stands in for the platform hop between them, so a call from Notes arrives at Todo's peer
 * door as `notes`, admitted by Todo's own `peers` declaration and nothing else.
 *
 * Nobody is seated in Notes. Its scope starts empty and stays that way until a person signs in
 * and Todo says who they are.
 *
 * The broker also carries a call Todo makes AS a person (#3161). What answers for it is the
 * platform layer in front of Notes' scopes, which locally is this harness: Notes' client id, and
 * its person contract's door for the token the call carries (`servePeople`).
 */
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import {
  createLocalVerticalBroker,
  type LocalDelegatedAnswer,
  type LocalVerticalClient,
} from '@substrat-run/adapter-sqlite/vertical-broker';
import { scopeId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import type { DevPeople } from '@substrat-run/dev-issuer';
import { DEV_PROVIDER } from '@substrat-run/demo-todo/src/personas.js';
import { buildHost as buildTodoHost, seed as seedTodo, type World as TodoWorld } from '@substrat-run/demo-todo/src/seed.js';
import { notesManifest } from './manifest.js';
import { MODULES, ROLES, permissions } from './provision.js';
import { NOTES_CLIENT_ID } from './delegations.js';

export { DEV_PROVIDER };

export function buildHost(dir: string): SqliteScopeHost {
  const host = new SqliteScopeHost({ dir, permissions });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/**
 * Install Notes in Todo's home tenant. Each host keeps its own directory, so the tenant is
 * created here under the id Todo gave it: one tenant, two apps.
 */
export async function installNotes(
  host: SqliteScopeHost,
  world: Pick<TodoWorld, 'staff' | 'tenant'>,
  scope: ScopeId = scopeId.parse(ulid()),
): Promise<{ tenantId: TenantId; scopeId: ScopeId }> {
  const { staff, tenant } = world;
  await host.admin.registerIdentityPool(staff, { provider: DEV_PROVIDER, topology: 'central', tenantId: null });
  await host.admin.createTenant(staff, { id: tenant, slug: `notes-${tenant.slice(-6).toLowerCase()}`, name: 'Todo' });
  await host.admin.grantEntitlement(staff, tenant, notesManifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical: 'notes' });
  await host.admin.activateScope(staff, tenant, scope);
  for (const role of ROLES) await host.admin.defineRole(staff, tenant, role);
  return { tenantId: tenant, scopeId: scope };
}

export interface Pair {
  todo: SqliteScopeHost;
  notes: SqliteScopeHost;
  world: TodoWorld;
  /** The one scope of Notes: the plugin, installed in Todo's home tenant. */
  node: { tenantId: TenantId; scopeId: ScopeId };
  /** Calls out as that scope of Notes, and as nothing else. */
  peer: LocalVerticalClient;
  /** Calls out as Todo's scope `node`: the master, calling its plugin. */
  todoClientFor(node: { tenantId: TenantId; scopeId: ScopeId }): LocalVerticalClient;
  /**
   * Answer calls made for a person with `people`, Notes' door for its ONE scope `node`. Until
   * this is called, every such call is refused.
   */
  servePeople(people: Pick<DevPeople, 'delegated'>, node: Pair['node']): void;
}

/** The hosts over `dir`, and the broker between them. Seeds nothing. */
export function buildPair(
  dir: string,
): Pick<Pair, 'todo' | 'notes' | 'todoClientFor' | 'servePeople'> & { peerFor(node: Pair['node']): LocalVerticalClient } {
  const todo = buildTodoHost(join(dir, 'todo'));
  const notes = buildHost(join(dir, 'notes'));
  let served: { people: Pick<DevPeople, 'delegated'>; node: Pair['node'] } | undefined;
  const broker = createLocalVerticalBroker(
    { todo, notes },
    {
      notes: {
        clientId: NOTES_CLIENT_ID,
        async delegated({ token, caller, target }): Promise<LocalDelegatedAnswer> {
          // The door admits a person into the one scope it serves, and `devPeople` does not know
          // which scope the broker resolved: a call for any other is refused here, before the token.
          if (!served || target.tenantId !== served.node.tenantId || target.scopeId !== served.node.scopeId) {
            return { admitted: false, reason: 'not-served' };
          }
          const answer = await served.people.delegated({ token, callerVertical: caller.vertical });
          if ('refused' in answer) return { admitted: false, reason: answer.refused };
          return { admitted: true, principal: answer.caller.principal, scope: answer.scope, actor: answer.actor };
        },
      },
    },
  );
  return {
    todo,
    notes,
    peerFor: (node) => broker.clientFor({ vertical: 'notes', ...node }),
    todoClientFor: (node) => broker.clientFor({ vertical: 'todo', ...node }),
    servePeople: (people, node) => void (served = { people, node }),
  };
}

/** A fresh pair: Todo's world seeded, Notes installed beside it. */
export async function seedPair(dir: string): Promise<Pair> {
  const { peerFor, ...pair } = buildPair(dir);
  const world = await seedTodo(pair.todo);
  const node = await installNotes(pair.notes, world);
  return { ...pair, world, node, peer: peerFor(node) };
}
