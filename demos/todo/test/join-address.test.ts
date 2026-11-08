/**
 * `todo/share-list` finds a person by the address they joined with, so that address is the
 * issuer's word and never input (#1359, K-61). `todo/join` takes none, and reads
 * `ctx.verifiedEmail`, which the door hands over. Driven through `createApp` — the dev
 * server's own wiring — with the session stubbed, since the claim is what is under test and
 * the round-trip is the dev issuer's suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { principalId, type PrincipalId } from '@substrat-run/contracts';
import type { DevCaller } from '@substrat-run/dev-issuer';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { createApp } from '../src/app.js';
import { buildHost, seed, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;
let app: Hono;

/** Who each `x-test-sub` is: what the directory resolved, with what `verifiedEmailOf` answered. */
const sessions = new Map<string, DevCaller>();

function signIn(sub: string, principal: PrincipalId, email: string | null, verified: boolean): string {
  sessions.set(sub, {
    principal,
    tenantId: world.tenant,
    scopeId: world.scope,
    sub,
    display: sub,
    email,
    verifiedEmail: verified ? email : null,
  });
  return sub;
}

/** A new member of the seeded scope, signed in with `email` and whether the issuer verified it. */
async function member(email: string | null, verified: boolean): Promise<string> {
  const principal = principalId.parse(ulid());
  await host.admin.assignRole(world.staff, {
    principalId: principal,
    roleKey: 'member',
    node: { tenantId: world.tenant, scopeId: world.scope },
  });
  return signIn(`sub-${principal}`, principal, email, verified);
}

const send = (path: string, sub: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'x-test-sub': sub }, body: JSON.stringify(body) });

/** The operation through the other door the mount serves: the MCP tool `todo_join`. */
async function joinOverMcp(sub: string, args: unknown): Promise<{ isError?: boolean; content: { text: string }[] }> {
  const res = await send('/api/mcp', sub, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'todo_join', arguments: args },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
}

async function shareTo(email: string): Promise<Response> {
  const list = (await (await send('/api/lists', 'ada', { name: `for ${email}` })).json()) as { id: string };
  return send(`/api/lists/${list.id}/shares`, 'ada', { email });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'todo-join-'));
  host = buildHost(dir);
  world = await seed(host);
  // Ada is seeded and joined; she is the one sharing.
  signIn('ada', world.ada.principal, world.ada.email, true);
  app = createApp({
    host,
    login: {
      handle: async () => new Response(null, { status: 404 }),
      caller: async (h) => sessions.get(h.get('x-test-sub') ?? '') ?? null,
    },
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('joining records the session’s verified address, whatever the caller sends', () => {
  it('stores the issuer’s spelling, and a share then finds the person', async () => {
    const sub = await member('Erik@Example.com', true);
    const res = await send('/api/join', sub, { displayName: 'Erik' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { email: string }).email).toBe('Erik@Example.com');
    expect((await shareTo('erik@example.com')).status).toBe(200);
  });

  it.each([
    ['over HTTP', async (sub: string, args: unknown) => void (await send('/api/join', sub, args))],
    ['over MCP', async (sub: string, args: unknown) => void (await joinOverMcp(sub, args))],
  ])('an address in the call claims nothing %s', async (_door, joinWith) => {
    const victim = `victim-${ulid().toLowerCase()}@example.com`;
    const sub = await member(`mallory-${ulid().toLowerCase()}@example.com`, true);
    await joinWith(sub, { email: victim, displayName: 'Mallory' });
    expect((await shareTo(victim)).status).toBe(404);
  });

  it.each([
    ['the issuer did not verify it', 'gunnar@example.com'],
    ['the session carries no address', null],
  ] as const)('refuses when %s', async (_label, email) => {
    const sub = await member(email, false);
    const res = await send('/api/join', sub, { displayName: 'Gunnar' });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('verified email address');
  });

  it('refuses over MCP too', async () => {
    const sub = await member('petra@example.com', false);
    expect((await joinOverMcp(sub, { displayName: 'Petra' })).isError).toBe(true);
    expect((await shareTo('petra@example.com')).status).toBe(404);
  });

  it('leaves a malformed body to the operation’s own parse', async () => {
    const sub = await member('hugo@example.com', true);
    expect((await send('/api/join', sub, {})).status).toBe(400);
  });

  it('leaves an anonymous call to the mount’s 401', async () => {
    expect((await app.request('/api/join', { method: 'POST', body: '{}' })).status).toBe(401);
  });
});
