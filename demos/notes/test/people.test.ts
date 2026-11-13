/**
 * The plugin takes its people from the app it belongs to — over HTTP, as several people.
 *
 * Both apps are driven through their own `createApp`, each on its own host, with the local
 * broker between them: the call that asks Todo who somebody is goes through Todo's real peer
 * door. Only the session is stubbed (`x-test-sub` names the login), since the round-trip is the
 * dev issuer's suite, and the door's clock is the test's, so the time an answer is kept for is
 * crossed by moving it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Hono } from 'hono';
import { principalId, type PrincipalId } from '@substrat-run/contracts';
import { PEOPLE_TTL_SECONDS, devPeople, type DevCaller } from '@substrat-run/dev-issuer';
import { ulid } from '@substrat-run/kernel';
import { createApp as createTodoApp } from '@substrat-run/demo-todo/src/app.js';
import { createApp } from '../src/app.js';
import { rolesFromTodo } from '../src/provision.js';
import { DEV_PROVIDER, seedPair, type Pair } from '../src/seed.js';

let dir: string;
let pair: Pair;
let todoApp: Hono;
let notesApp: Hono;

/** The door's clock, and whether Todo can be reached. */
let now = Date.UTC(2026, 10, 13);
let todoDown = false;
const expire = () => void (now += PEOPLE_TTL_SECONDS * 1000);

/** Who each `x-test-sub` is at the issuer, and in Todo once they have joined there. */
const logins = new Map<string, { email: string; todo?: DevCaller }>();

const sub = (headers: Headers) => headers.get('x-test-sub');
const as = (who: string, init: RequestInit = {}) => ({ ...init, headers: { 'x-test-sub': who } });
const post = (body?: unknown): RequestInit => ({ method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** A new member of Todo's home scope, joined with a verified address. Returns their login. */
async function member(name: string): Promise<{ sub: string; principal: PrincipalId }> {
  const principal = principalId.parse(ulid());
  const login = `test|${name}`;
  const email = `${name}@example.com`;
  const node = { tenantId: pair.world.tenant, scopeId: pair.world.scope };
  await pair.todo.admin.assignRole(pair.world.staff, { principalId: principal, roleKey: 'member', node });
  const todo: DevCaller = { principal, ...node, sub: login, display: name, email, verifiedEmail: email };
  logins.set(login, { email, todo });
  expect((await todoApp.request('/api/me', as(login))).status).toBe(200);
  return { sub: login, principal };
}

/** Ada, Todo's admin, gives or takes a member's plugin access through Todo's own API. */
const access = (principal: PrincipalId, method: 'POST' | 'DELETE') =>
  todoApp.request(`/api/members/${principal}/plugin-access`, as('dev|ada', { method }));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'notes-people-'));
  pair = await seedPair(dir);
  const { world } = pair;
  logins.set('dev|ada', {
    email: world.ada.email,
    todo: { principal: world.ada.principal, tenantId: world.tenant, scopeId: world.scope, sub: 'dev|ada', display: 'Ada', email: world.ada.email, verifiedEmail: world.ada.email },
  });
  // Cleo is a member of Todo in ANOTHER tenant: signed in at the same issuer, nobody here.
  logins.set('dev|cleo', { email: world.cleo.email });

  todoApp = createTodoApp({
    host: pair.todo,
    login: { handle: async () => new Response(null, { status: 404 }), caller: async (headers) => logins.get(sub(headers) ?? '')?.todo ?? null },
  });
  const people = devPeople({
    login: {
      issuer: 'https://issuer.test',
      subject: async (headers) => {
        const login = sub(headers);
        const known = login === null ? undefined : logins.get(login);
        return known ? { sub: login!, email: known.email, name: null, emailVerified: true } : null;
      },
    },
    db: new Database(join(dir, 'people.sqlite')),
    host: pair.notes,
    actor: world.staff,
    provider: DEV_PROVIDER,
    node: pair.node,
    resolve: async (login) => {
      if (todoDown) throw new Error('todo is unreachable');
      return pair.peer.invoke('todo', 'todo/resolve-person', login);
    },
    roles: rolesFromTodo,
    now: () => new Date(now),
  });
  notesApp = createApp({
    host: pair.notes,
    login: { handle: async () => new Response(null, { status: 404 }) },
    people,
    vouch: async (principal, at) => {
      if (todoDown) throw new Error('todo is unreachable');
      return pair.peer.invoke('todo', 'todo/vouch-access', { principal, ...at });
    },
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('a plugin that takes its people from Todo', () => {
  it('lets in a member Todo gave plugin access, as the same person', async () => {
    const dana = await member('dana');
    expect((await access(dana.principal, 'POST')).status).toBe(200);

    const written = await notesApp.request('/api/notes', as(dana.sub, post({ text: 'bring the projector' })));
    expect(written.status).toBe(200);
    // One person, one id: the note's author is the member's principal in Todo.
    expect(((await written.json()) as { author_id: string }).author_id).toBe(dana.principal);

    const read = await notesApp.request('/api/notes', as(dana.sub));
    expect(((await read.json()) as { text: string }[]).map((n) => n.text)).toContain('bring the projector');
  });

  it('refuses a login Todo has nobody for in this tenant, and nobody at all', async () => {
    expect((await notesApp.request('/api/notes', as('dev|cleo'))).status).toBe(403);
    expect((await notesApp.request('/api/notes')).status).toBe(401);
  });

  it('access taken away in Todo is lost here when the kept answer expires, and not before', async () => {
    const erik = await member('erik');
    await access(erik.principal, 'POST');
    expect((await notesApp.request('/api/notes', as(erik.sub))).status).toBe(200);

    expect((await access(erik.principal, 'DELETE')).status).toBe(200);
    // Inside the time the answer is kept for: the bound is real, and this is its cost.
    expect((await notesApp.request('/api/notes', as(erik.sub))).status).toBe(200);

    expire();
    // Still a member of Todo, so still signed in here, and holding nothing.
    expect((await notesApp.request('/api/me', as(erik.sub))).status).toBe(200);
    expect((await notesApp.request('/api/notes', as(erik.sub))).status).toBe(403);
  });

  it("keeps notes on a Todo item for the people Todo says may see it, and refuses the rest alike", async () => {
    const gus = await member('gus');
    await access(gus.principal, 'POST');
    const ada = await pair.todo.getScope(pair.world.ada.principal, pair.world.tenant, pair.world.scope);
    const shared = await ada.invoke<{ id: string }, unknown>('todo/create-list', { name: 'Offsite' });
    const own = await ada.invoke<{ id: string }, unknown>('todo/create-list', { name: 'Ada only' });
    await ada.invoke('todo/share-list', { listId: shared.id, email: 'gus@example.com' });
    const item = await ada.invoke<{ id: string }, unknown>('todo/add-item', { listId: shared.id, text: 'book the room' });
    const hidden = await ada.invoke<{ id: string }, unknown>('todo/add-item', { listId: own.id, text: 'secret' });

    const added = await notesApp.request(`/api/items/${item.id}/notes`, as(gus.sub, post({ text: 'the big one, please' })));
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ item_id: item.id, list_id: shared.id, author_id: gus.principal });

    const read = await notesApp.request(`/api/lists/${shared.id}/item-notes`, as(gus.sub));
    expect(((await read.json()) as { entries: { text: string }[] }).entries.map((n) => n.text)).toEqual(['the big one, please']);
    // Not on the workspace notepad: a note on an item is for the people who may see the item.
    const pad = (await (await notesApp.request('/api/notes', as(gus.sub))).json()) as { text: string }[];
    expect(pad.map((n) => n.text)).not.toContain('the big one, please');

    // Across lists, only the notes on lists he may see: Ada's note on her own list stays hers.
    await access(pair.world.ada.principal, 'POST');
    expect((await notesApp.request(`/api/items/${hidden.id}/notes`, as('dev|ada', post({ text: 'only mine' })))).status).toBe(200);
    const all = (await (await notesApp.request('/api/item-notes', as(gus.sub))).json()) as { entries: { text: string }[] };
    expect(all.entries.map((n) => n.text)).toEqual(['the big one, please']);
    const adas = (await (await notesApp.request('/api/item-notes', as('dev|ada'))).json()) as { entries: { text: string }[] };
    expect(adas.entries.map((n) => n.text).sort()).toEqual(['only mine', 'the big one, please']);

    // A list nobody shared with him, an item on it, and an id that is nothing: the same 403.
    expect((await notesApp.request(`/api/lists/${own.id}/item-notes`, as(gus.sub))).status).toBe(403);
    expect((await notesApp.request(`/api/items/${hidden.id}/notes`, as(gus.sub, post({ text: 'x' })))).status).toBe(403);
    expect((await notesApp.request('/api/items/nothing/notes', as(gus.sub, post({ text: 'x' })))).status).toBe(403);
  });

  it('admits nobody on an expired answer while Todo cannot be reached', async () => {
    const frida = await member('frida');
    await access(frida.principal, 'POST');
    expect((await notesApp.request('/api/notes', as(frida.sub))).status).toBe(200);

    todoDown = true;
    try {
      // The kept answer still stands, so an outage shorter than it goes unnoticed.
      expect((await notesApp.request('/api/notes', as(frida.sub))).status).toBe(200);
      expire();
      expect((await notesApp.request('/api/notes', as(frida.sub))).status).toBe(503);
    } finally {
      todoDown = false;
    }
    expect((await notesApp.request('/api/notes', as(frida.sub))).status).toBe(200);
  });
});
