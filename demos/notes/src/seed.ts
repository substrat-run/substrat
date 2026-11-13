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
 */
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { createLocalVerticalBroker, type LocalVerticalClient } from '@substrat-run/adapter-sqlite/vertical-broker';
import { scopeId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { DEV_PROVIDER } from '@substrat-run/demo-todo/personas';
import { buildHost as buildTodoHost, seed as seedTodo, type World as TodoWorld } from '@substrat-run/demo-todo/seed';
import { notesManifest } from './manifest.js';
import { MODULES, ROLES, permissions } from './provision.js';

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
}

/** The hosts over `dir`, and the broker between them. Seeds nothing. */
export function buildPair(dir: string): Pick<Pair, 'todo' | 'notes'> & { peerFor(node: Pair['node']): LocalVerticalClient } {
  const todo = buildTodoHost(join(dir, 'todo'));
  const notes = buildHost(join(dir, 'notes'));
  const broker = createLocalVerticalBroker({ todo, notes });
  return { todo, notes, peerFor: (node) => broker.clientFor({ vertical: 'notes', ...node }) };
}

/** A fresh pair: Todo's world seeded, Notes installed beside it. */
export async function seedPair(dir: string): Promise<Pair> {
  const { todo, notes, peerFor } = buildPair(dir);
  const world = await seedTodo(todo);
  const node = await installNotes(notes, world);
  return { todo, notes, world, node, peer: peerFor(node) };
}
