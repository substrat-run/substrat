/**
 * Todo calls Notes AS the person signed in to Todo (#3161) — over HTTP, through Todo's own routes.
 *
 * Both apps on their own hosts, the local broker between them, and the dev issuer in process with
 * Notes' declared delegation (`src/delegations.ts`). Nothing is stubbed on the way: each person
 * signs in at Todo through the real login round-trip (with `offline_access`, so Todo keeps the
 * refresh token it acts from), Todo trades it for a token addressed to Notes, and Notes' person
 * contract door admits whoever the token names. Only the door's clock is the test's, so the time
 * Todo's answer is kept for is crossed by moving it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Hono } from 'hono';
import { errorCodeOf, type PrincipalId } from '@substrat-run/contracts';
import { PEOPLE_TTL_SECONDS, createDevIssuer, devDelegate, devLogin, devPeople, devRefreshStore, type DevDelegate } from '@substrat-run/dev-issuer';
import { PERSONAS } from '@substrat-run/demo-todo/src/personas.js';
import { createApp as createTodoApp } from '@substrat-run/demo-todo/src/app.js';
import { DELEGATIONS, NOTES_CLIENT_ID, TODO_CLIENT_ID } from '../src/delegations.js';
import { notesManifest } from '../src/manifest.js';
import { rolesFromTodo } from '../src/provision.js';
import { DEV_PROVIDER, installNotes, seedPair, type Pair } from '../src/seed.js';
import { NOTES_VIA_TODO, notesCallRoutes } from '../src/todo-calls.js';

// Loopback, as the real dev issuer is (the relying party takes plain http only there). Nothing
// listens on it: `fetch` to it is handed to the issuer in this process.
const ISSUER = 'http://localhost:18879';
const TODO = 'http://todo.test';
const issuer = createDevIssuer({ personas: PERSONAS, delegations: DELEGATIONS, allowedRedirectPrefixes: [TODO] });

let realFetch: typeof globalThis.fetch;
let dir: string;
let pair: Pair;
let todoApp: Hono;
let store: ReturnType<typeof devRefreshStore>;
let todoLogin: ReturnType<typeof devLogin>;
let delegate: DevDelegate;
let ada: Headers;
let bjorn: Headers;

/** The door's clock. */
let now = Date.UTC(2026, 10, 15);
const expire = () => void (now += PEOPLE_TTL_SECONDS * 1000);

const cookieOf = (res: Response) =>
  res.headers.getSetCookie().map((c) => c.split(';')[0]!).filter((c) => !c.endsWith('=')).join('; ');

/** `sub` signs in at Todo with the issuer's picker; the session cookie, and Todo has seen them. */
async function signIn(sub: string): Promise<Headers> {
  const begin = await todoApp.request(`${TODO}/api/auth/login`);
  const picked = await issuer.fetch(new Request(`${begin.headers.get('location')}&sub=${encodeURIComponent(sub)}`, { redirect: 'manual' }));
  const done = await todoApp.request(picked.headers.get('location') ?? '', { headers: { cookie: cookieOf(begin) } });
  expect(done.status).toBe(302);
  const session = new Headers({ cookie: cookieOf(done) });
  expect((await todoApp.request(`${TODO}/api/me`, { headers: session })).status).toBe(200);
  return session;
}

/** Ada, Todo's admin, gives or takes a member's plugin access through Todo's own API. */
const access = (principal: PrincipalId, method: 'POST' | 'DELETE') =>
  todoApp.request(`${TODO}/api/members/${principal}/plugin-access`, { method, headers: ada });

const notes = (session: Headers, text?: string) =>
  todoApp.request(`${TODO}${NOTES_VIA_TODO}`, {
    headers: session,
    ...(text === undefined ? {} : { method: 'POST', body: JSON.stringify({ text }) }),
  });

const codeOf = (call: Promise<unknown>) => call.then(() => 'answered', (e: unknown) => errorCodeOf(e));

beforeAll(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input, init);
    return req.url.startsWith(ISSUER) ? Promise.resolve(issuer.fetch(req)) : realFetch(input, init);
  }) as typeof globalThis.fetch;

  dir = mkdtempSync(join(tmpdir(), 'notes-delegated-'));
  pair = await seedPair(dir);
  const { world } = pair;

  store = devRefreshStore(new Database(':memory:'));
  todoLogin = devLogin({ issuer: ISSUER, clientId: TODO_CLIENT_ID, refreshStore: store, directory: pair.todo.admin, actor: world.staff, provider: DEV_PROVIDER });
  delegate = devDelegate({ login: todoLogin, store, peer: pair.todoClientFor({ tenantId: world.tenant, scopeId: world.scope }) });
  todoApp = createTodoApp({ host: pair.todo, login: todoLogin, routes: notesCallRoutes(delegate) });

  const notesLogin = devLogin({
    issuer: ISSUER,
    clientId: NOTES_CLIENT_ID,
    delegation: { actors: [TODO_CLIENT_ID], channels: ['peer'] },
    directory: pair.notes.admin,
    actor: world.staff,
    provider: DEV_PROVIDER,
  });
  const people = devPeople({
    login: notesLogin,
    master: 'todo',
    delegations: notesManifest.delegations ?? [],
    db: new Database(join(dir, 'people.sqlite')),
    host: pair.notes,
    actor: world.staff,
    provider: DEV_PROVIDER,
    node: pair.node,
    resolve: (login) => pair.peer.invoke('todo', 'todo/resolve-person', login),
    roles: rolesFromTodo,
    now: () => new Date(now),
  });
  pair.servePeople(people, pair.node);

  ada = await signIn('dev|ada');
  bjorn = await signIn('dev|bjorn');
  expect((await access(world.ada.principal, 'POST')).status).toBe(200);
});

afterAll(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

describe('Todo calls Notes as the person signed in to Todo', () => {
  it('writes and reads a note as Ada, and Notes records Ada as its author', async () => {
    const written = await notes(ada, 'agenda for Monday');
    expect(written.status).toBe(200);
    const note = (await written.json()) as { id: string; author_id: string };
    expect(note.author_id).toBe(pair.world.ada.principal);

    const read = (await (await notes(ada)).json()) as { entries: { id: string; text: string }[] };
    expect(read.entries.map((n) => n.text)).toContain('agenda for Monday');
    // What Notes keeps, read by Ada at Notes herself rather than through Todo.
    const own = await pair.notes.getScope(pair.world.ada.principal, pair.node.tenantId, pair.node.scopeId);
    const kept = await own.invoke<{ entries: { id: string; author_id: string }[] }, unknown>('notes/list-notes', {});
    expect(kept.entries.find((n) => n.id === note.id)?.author_id).toBe(pair.world.ada.principal);
  });

  it('cannot reach an item note, though Ada holds its keys: Todo was delegated the notepad’s only', async () => {
    // The item-note operations trust Notes' door to have asked Todo to vouch, and a delegated
    // call does not pass that door. So the delegation's ceiling is all that stands in front.
    const listId = 'a-list-nobody-vouched-for';
    expect(await codeOf(delegate.invoke(ada, 'notes', 'notes/add-item-note', { itemId: 'an-item', listId, text: 'x' }))).toBe('permission_denied');
    expect(await codeOf(delegate.invoke(ada, 'notes', 'notes/list-item-notes', {}))).toBe('permission_denied');

    // Ada at Notes herself holds both keys, and the refused write left nothing behind.
    const own = await pair.notes.getScope(pair.world.ada.principal, pair.node.tenantId, pair.node.scopeId);
    await own.invoke('notes/add-item-note', { itemId: 'an-item', listId, text: 'written at Notes' });
    const items = await own.invoke<{ entries: { text: string }[] }, unknown>('notes/list-item-notes', {});
    expect(items.entries.map((n) => n.text)).toEqual(['written at Notes']);
  });

  it('refuses Björn without plugin access, admits him once given it, and refuses him again once the kept answer expires', async () => {
    const { bjorn: who } = pair.world;
    expect((await notes(bjorn)).status).toBe(403);

    expect((await access(who.principal, 'POST')).status).toBe(200);
    expire();
    expect((await notes(bjorn, 'from Björn')).status).toBe(200);

    expect((await access(who.principal, 'DELETE')).status).toBe(200);
    // Inside the time the answer is kept for: the bound is real, and this is its cost.
    expect((await notes(bjorn)).status).toBe(200);
    expire();
    expect((await notes(bjorn)).status).toBe(403);
  });

  it('refuses everyone through Todo while the operator has Todo switched off as a peer here, and admits them again once on', async () => {
    const peerSwitch = { vertical: 'todo', node: pair.node, reason: 'incident' };
    await pair.notes.admin.revokeFromPeer(pair.world.staff, peerSwitch);
    try {
      expect((await notes(ada)).status).toBe(403);
      expect(await codeOf(delegate.invoke(ada, 'notes', 'notes/list-notes', {}))).toBe('forbidden');
    } finally {
      await pair.notes.admin.restoreToPeer(pair.world.staff, { ...peerSwitch, reason: 'resolved' });
    }
    expect((await notes(ada)).status).toBe(200);
  });

  it('refuses a call for a Notes scope the harness does not serve, before reading the token, saying why only on the operator’s line', async () => {
    const { world } = pair;
    // Notes installed in Todo's other tenant too, and Todo's scope there calling it as Ada.
    const other = await installNotes(pair.notes, { staff: world.staff, tenant: world.otherTenant });
    const elsewhere = devDelegate({ login: todoLogin, store, peer: pair.todoClientFor({ tenantId: world.otherTenant, scopeId: world.otherScope }) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const refused = await elsewhere.invoke(ada, 'notes', 'notes/list-notes', {}).catch((e: unknown) => e);
      expect(errorCodeOf(refused)).toBe('forbidden');
      expect((refused as Error).message).toBe('this call for a person was refused');
      expect(warn.mock.calls.map((c) => JSON.parse(String(c[0])) as unknown)).toContainEqual({
        host: 'peer-on-behalf-refused', ...other, caller: 'todo', reason: 'not-served',
      });
    } finally {
      warn.mockRestore();
    }
  });
});
