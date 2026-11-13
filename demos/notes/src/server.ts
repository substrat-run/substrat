/**
 * The boot harness: Notes AND the Todo it is a plugin of, in one process.
 *
 * In production these are two deployments and the platform carries the call between them. A
 * dev server has no platform, so the local broker does, and a broker is an in-process object:
 * both hosts have to live here. Todo's API is served too (on `TODO_PORT`), from this
 * process's own copy of its world, so an admin can give and take plugin access while Notes
 * runs. It is not the world `pnpm todo-demo dev` serves.
 *
 *     pnpm --filter @substrat-run/demo-notes dev
 *
 *     # sign in as a persona, for a script: the issuer's own shortcut
 *     curl -s localhost:8879/dev/token -d '{"sub":"dev|bjorn"}' -H 'content-type: application/json'
 *     curl -s localhost:8881/api/notes -H "authorization: Bearer $TOKEN"
 *
 * Four processes: the issuer, this API (with Todo's beside it), Notes' web app on :5281, and
 * Todo's own web app on :5278 pointed at the Todo served here. Sign in to either; the session
 * cookie is shared across localhost ports, so the other app knows you too.
 *
 * Björn is refused until Ada gives him plugin access on Todo's Plugins screen, and again after
 * she takes it away, within `PEOPLE_TTL_SECONDS` (30 here, 300 for the door's own default).
 */
import { serve } from '@hono/node-server';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { devLogin, devPeople } from '@substrat-run/dev-issuer';
import { createApp as createTodoApp } from '@substrat-run/demo-todo/src/app.js';
import { grantOwner, linkDevPersonas, reconcileOwnerGrants, seed as seedTodo, type World } from '@substrat-run/demo-todo/src/seed.js';
import { createApp } from './app.js';
import { rolesFromTodo } from './provision.js';
import { DEV_PROVIDER, buildPair, installNotes } from './seed.js';

const DATA = process.env.DATA_DIR ?? '.data';
const CAST = join(DATA, 'pair.json');

async function boot() {
  mkdirSync(DATA, { recursive: true });
  const { todo, notes, peerFor } = buildPair(DATA);

  // Seed once. A pair on disk means both worlds already exist.
  let saved: { world: World; notesScope: string };
  if (existsSync(CAST)) {
    saved = JSON.parse(readFileSync(CAST, 'utf8')) as typeof saved;
  } else {
    const world = await seedTodo(todo);
    const node = await installNotes(notes, world);
    saved = { world, notesScope: node.scopeId };
    writeFileSync(CAST, JSON.stringify(saved, null, 2));
  }
  // Re-branded on the way in: everything loaded from JSON crossed a serialization boundary.
  const staff = platformActorId.parse(saved.world.staff);
  const world = { ...saved.world, staff };
  const node = { tenantId: tenantId.parse(world.tenant), scopeId: scopeId.parse(saved.notesScope) };
  await linkDevPersonas(todo, world);
  await reconcileOwnerGrants(todo, world);
  // Re-provision both scopes, as a deploy does: provisioning is idempotent, and it is what seats
  // the keys a peer is declared to hold. A world saved before Todo declared a new one for Notes
  // would otherwise refuse Notes that key until `.data` is wiped.
  await todo.provisionScope(staff, { tenantId: world.tenant, scopeId: scopeId.parse(world.scope), vertical: 'todo' });
  await notes.provisionScope(staff, { ...node, vertical: 'notes' });

  const todoLogin = devLogin({ directory: todo.admin, actor: staff, provider: DEV_PROVIDER });
  const todoApp = createTodoApp({
    host: todo,
    login: todoLogin,
    onJoined: (caller) => grantOwner(todo, staff, { tenantId: caller.tenantId, scopeId: caller.scopeId }, caller.principal),
  });

  // Notes' own relying party at the same issuer. Its `caller` is never asked: who a login is
  // here is Todo's to say, through the person contract.
  const login = devLogin({ directory: notes.admin, actor: staff, provider: DEV_PROVIDER });
  const ttlSeconds = Number(process.env.PEOPLE_TTL_SECONDS ?? 30);
  const peer = peerFor(node);
  const people = devPeople({
    login,
    db: new Database(join(DATA, 'people.sqlite')),
    host: notes,
    actor: staff,
    provider: DEV_PROVIDER,
    node,
    resolve: (person) => peer.invoke('todo', 'todo/resolve-person', person),
    roles: rolesFromTodo,
    // Shorter than the door's 300 s, so a switch flipped in Todo shows here while you watch.
    // The bound is the same mechanism at any value; `PEOPLE_TTL_SECONDS=300` shows the real one.
    ttlSeconds,
  });
  const app = createApp({
    host: notes,
    login,
    people,
    vouch: (principal, at) => peer.invoke('todo', 'todo/vouch-access', { principal, ...at }),
  });

  const port = Number(process.env.PORT ?? 8881);
  const todoPort = Number(process.env.TODO_PORT ?? 8882);
  serve({ fetch: app.fetch, port });
  serve({ fetch: todoApp.fetch, port: todoPort });
  process.stdout.write(
    `notes api on :${port} · its todo on :${todoPort} — auth: OIDC · ${login.issuer} · ` +
      `an answer from todo is kept ${ttlSeconds} s\n`,
  );
}

void boot();
