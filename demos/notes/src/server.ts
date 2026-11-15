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
 *     # sign in as a persona, for a script: the issuer's own shortcut, for Notes' own client
 *     curl -s localhost:8879/dev/token -d '{"sub":"dev|bjorn","audience":"notes"}' -H 'content-type: application/json'
 *     curl -s localhost:8881/api/notes -H "authorization: Bearer $TOKEN"
 *
 * Three processes: the issuer, this API (with Todo's beside it), and Todo's own web app on :5278
 * pointed at the Todo served here. Notes has no screens of its own: Todo's app draws what the
 * plugin adds, for whoever the plugin lets in, and reaches this API through its dev proxy.
 *
 * Björn is refused until Ada gives him plugin access on Todo's Plugins screen, and again after
 * she takes it away, within `PEOPLE_TTL_SECONDS` (30 here, 300 for the door's own default).
 *
 * Todo also calls Notes AS the person signed in to it (#3161): `GET`/`POST /api/plugins/notes/notes`
 * on Todo's port read and write the notepad as them. That needs a sign-in through Todo's login
 * (a `/dev/token` bearer has no session to act from), the issuer started with Notes' delegations
 * (the `issuer` script passes `--delegations src/delegations.ts`), and distinct clients: Todo signs
 * in as `todo`, Notes as `notes`.
 */
import { serve } from '@hono/node-server';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { devDelegate, devLogin, devPeople, devRefreshStore } from '@substrat-run/dev-issuer';
import { createApp as createTodoApp } from '@substrat-run/demo-todo/src/app.js';
import { grantOwner, linkDevPersonas, reconcileOwnerGrants, seed as seedTodo, type World } from '@substrat-run/demo-todo/src/seed.js';
import { createApp } from './app.js';
import { NOTES_CLIENT_ID, TODO_CLIENT_ID } from './delegations.js';
import { ROLES, rolesFromTodo } from './provision.js';
import { notesCallRoutes } from './todo-calls.js';
import { DEV_PROVIDER, buildPair, installNotes } from './seed.js';

const DATA = process.env.DATA_DIR ?? '.data';
const CAST = join(DATA, 'pair.json');

async function boot() {
  mkdirSync(DATA, { recursive: true });
  const { todo, notes, peerFor, todoClientFor, servePeople } = buildPair(DATA);

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
  // And Notes' roles, which a deploy defines from the vertical's own: a world saved before a role
  // gained a key would otherwise refuse that key to everyone holding the role.
  for (const role of ROLES) await notes.admin.defineRole(staff, node.tenantId, role);

  // Todo keeps each session's refresh token, so it can call Notes as the person signed in.
  const refresh = devRefreshStore(new Database(join(DATA, 'todo-refresh.sqlite')));
  const todoLogin = devLogin({ clientId: TODO_CLIENT_ID, refreshStore: refresh, directory: todo.admin, actor: staff, provider: DEV_PROVIDER });
  const delegate = devDelegate({ login: todoLogin, store: refresh, peer: todoClientFor({ tenantId: node.tenantId, scopeId: scopeId.parse(world.scope) }) });
  const todoApp = createTodoApp({
    host: todo,
    login: todoLogin,
    onJoined: (caller) => grantOwner(todo, staff, { tenantId: caller.tenantId, scopeId: caller.scopeId }, caller.principal),
    routes: notesCallRoutes(delegate),
  });

  // Notes' own relying party at the same issuer. Its `caller` is never asked: who a login is
  // here is Todo's to say, through the person contract. It takes the tokens Todo obtains to act
  // for a person, on the peer channel, and no other app's.
  const login = devLogin({
    clientId: NOTES_CLIENT_ID,
    delegation: { actors: [TODO_CLIENT_ID], channels: ['peer'] },
    directory: notes.admin,
    actor: staff,
    provider: DEV_PROVIDER,
  });
  const ttlSeconds = Number(process.env.PEOPLE_TTL_SECONDS ?? 30);
  const peer = peerFor(node);
  const people = devPeople({
    login,
    master: 'todo',
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
  servePeople(people, node);
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
