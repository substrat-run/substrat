/**
 * One todo scope as a shard holds it: a `SqliteScopeHost` over the scope's OWN directory.
 *
 * One directory per scope, not one per shard, so a scope can move by itself. That puts a
 * slice of the directory (the tenant row, the roles, the grants) inside every scope's
 * directory — the cheapest answer to question 5, and the wrong one for production: a
 * tenant with two scopes on two shards would have two directories that disagree. It is
 * here because question 5 is out of this slice, and it is named in FINDINGS.md.
 *
 * A side effect worth having: `SqliteScopeHost` takes an OS-level exclusive lock on its
 * directory (`_host.lock`), so on ONE machine a second process opening the same scope is
 * refused, and the lock dies with the process. That is a real fence, but only on one
 * node — see FINDINGS.md §2.
 */
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { platformActorId, principalId, scopeId as scopeIdOf, tenantId } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { buildHost, grantOwner, ROLES } from '@substrat-run/demo-todo/src/seed.js';
import { todoManifest } from '@substrat-run/demo-todo/src/manifest.js';

/** What a shard needs to address the scope's one list as its one member. */
export interface ScopeWorld {
  staff: string;
  tenant: string;
  scope: string;
  member: string;
  listId: string;
  /** When the scope was seeded (ms since the epoch): background slots count from here. */
  bornAt: number;
}

const WORLD = 'world.json';

export function scopeDir(volume: string, node: string, scopeId: string): string {
  return join(volume, node, 'scopes', scopeId);
}

/** Open the host over an existing scope directory (written by {@link seedScope} or {@link copyScope}). */
export function openScope(dir: string): { host: ScopeHost; world: ScopeWorld } {
  const world = JSON.parse(readFileSync(join(dir, WORLD), 'utf8')) as ScopeWorld;
  return { host: buildHost(dir), world };
}

/**
 * A brand-new scope: tenant, entitlement, scope, roles, one member who has joined and
 * owns one list. The same steps `demos/todo/src/seed.ts` takes for its first tenant.
 */
export async function seedScope(dir: string, id: string): Promise<{ host: ScopeHost; world: ScopeWorld }> {
  mkdirSync(dir, { recursive: true });
  const host = buildHost(dir);
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeIdOf.parse(id);
  const member = principalId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: `todo-${t.slice(-6).toLowerCase()}`, name: 'Todo' });
  await host.admin.grantEntitlement(staff, t, todoManifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'todo' });
  await host.admin.activateScope(staff, t, s);
  for (const role of ROLES) await host.admin.defineRole(staff, t, role);
  await host.admin.assignRole(staff, { principalId: member, roleKey: 'member', node: { tenantId: t, scopeId: s } });
  const stub = await host.getScope(member, t, s);
  await stub.invoke('todo/join', { email: 'member@example.com', displayName: 'Member' });
  await grantOwner(host, staff, { tenantId: t, scopeId: s }, member);
  const list = await stub.invoke<{ id: string }>('todo/create-list', { name: 'Writes' });
  const world: ScopeWorld = { staff, tenant: t, scope: s, member, listId: list.id, bornAt: Date.now() };
  writeFileSync(join(dir, WORLD), JSON.stringify(world));
  return { host, world };
}

/**
 * Take a scope over from another node's volume: every SQLite file through the online
 * backup API (a consistent snapshot even while the source is open, or was killed with a
 * WAL not yet checkpointed), everything else copied, the lock file never.
 *
 * This stands for "reattach the volume, or restore it from a synchronous replica". On one
 * runner the source volume is just a directory; in a cluster which of the two it is, and
 * what it costs, is question 3 (FINDINGS.md). What the spike relies on is only that the copy
 * is taken AFTER the previous holder's lease ended — that ordering is the lease's job.
 *
 * Files, not `exportScope`/`importScope`, on purpose: between two SQLite shards the files ARE
 * the scope, and the backup API copies them consistently (FINDINGS.md §4).
 */
export async function copyScope(from: string, to: string): Promise<void> {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    if (name.startsWith('_host.lock')) continue;
    if (name.endsWith('-wal') || name.endsWith('-shm') || name.endsWith('-journal')) continue;
    const stat = statSync(src);
    if (stat.isDirectory()) {
      await copyScope(src, join(to, name));
      continue;
    }
    if (stat.size >= 16 && isSqlite(src)) {
      const db = new Database(src, { fileMustExist: true });
      try {
        await db.backup(join(to, name));
      } finally {
        db.close();
      }
    } else {
      copyFileSync(src, join(to, name));
    }
  }
}

function isSqlite(path: string): boolean {
  const header = Buffer.alloc(16);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, header, 0, 16, 0);
  } finally {
    closeSync(fd);
  }
  return header.toString('latin1') === 'SQLite format 3\u0000';
}
