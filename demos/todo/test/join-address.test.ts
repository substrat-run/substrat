/**
 * `POST /api/join` records the address `todo/share-list` finds a person by, so the address
 * must be the one the issuer verified this session controls (#1359). Driven through
 * `createApp` — the dev server's own wiring — with the issuer's answer stubbed, since the
 * claim is what is under test and the round-trip is the dev issuer's suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { principalId, type PrincipalId } from '@substrat-run/contracts';
import type { AuthSubject, DevCaller } from '@substrat-run/dev-issuer';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import type { EmailIdentityEnv } from '@substrat-run/oidc-rp';
import { createApp } from '../src/app.js';
import { buildHost, seed, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;
let app: Hono;

/** Who each `x-test-sub` is: what the issuer answered, and what the directory resolved. */
const sessions = new Map<string, { subject: AuthSubject; caller: DevCaller }>();

function appWith(env: EmailIdentityEnv = {}): Hono {
  const session = (h: Headers) => sessions.get(h.get('x-test-sub') ?? '');
  return createApp({
    host,
    env,
    login: {
      handle: async () => new Response(null, { status: 404 }),
      subject: async (h) => session(h)?.subject ?? null,
      caller: async (h) => session(h)?.caller ?? null,
    },
  });
}

function signIn(sub: string, principal: PrincipalId, email: string | null, verified: boolean | undefined): string {
  sessions.set(sub, {
    subject: { sub, email, name: null, ...(verified === undefined ? {} : { emailVerified: verified }) },
    caller: { principal, tenantId: world.tenant, scopeId: world.scope, sub, display: sub },
  });
  return sub;
}

/** A new member of the seeded scope, signed in with `email` and the issuer's `verified` claim. */
async function member(email: string | null, verified: boolean | undefined): Promise<string> {
  const principal = principalId.parse(ulid());
  await host.admin.assignRole(world.staff, {
    principalId: principal,
    roleKey: 'member',
    node: { tenantId: world.tenant, scopeId: world.scope },
  });
  return signIn(`sub-${principal}`, principal, email, verified);
}

const send = (app: Hono, path: string, sub: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'x-test-sub': sub }, body: JSON.stringify(body) });

const joinAs = (app: Hono, sub: string, email: string) => send(app, '/api/join', sub, { email, displayName: 'Someone' });

/** The same operation through the other door the mount serves: the MCP tool `todo_join`. */
async function joinOverMcp(sub: string, email: string): Promise<{ isError?: boolean; content: { text: string }[] }> {
  const res = await send(app, '/api/mcp', sub, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'todo_join', arguments: { email, displayName: 'Someone' } },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'todo-join-'));
  host = buildHost(dir);
  world = await seed(host);
  // Ada is seeded and joined; she is the one sharing.
  signIn('ada', world.ada.principal, world.ada.email, true);
  app = appWith();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('joining records only the session’s own verified address', () => {
  it('admits the verified address the session signed in with', async () => {
    const sub = await member('dana@example.com', true);
    const res = await joinAs(app, sub, 'dana@example.com');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { email: string }).email).toBe('dana@example.com');
  });

  it('compares addresses without regard to case', async () => {
    const sub = await member('Erik@Example.com', true);
    expect((await joinAs(app, sub, 'erik@example.com')).status).toBe(200);
  });

  it('refuses a verified session claiming a different address', async () => {
    const sub = await member('mallory@example.com', true);
    const res = await joinAs(app, sub, 'frida@example.com');
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('join with the verified email address you signed in with');
  });

  it.each([
    ['the issuer said false', false, 'not verified'],
    ['the session carries no claim', undefined, 'sign in again'],
  ] as const)('refuses its own address when %s', async (_label, verified, says) => {
    const email = `g-${String(verified)}@example.com`;
    const sub = await member(email, verified);
    const res = await joinAs(app, sub, email);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(says);
  });

  it('refuses a session that carries no address at all', async () => {
    const sub = await member(null, true);
    const res = await joinAs(app, sub, 'nobody@example.com');
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('no email address');
  });

  it('leaves a malformed body to the operation’s own parse', async () => {
    const sub = await member('hugo@example.com', true);
    expect((await send(app, '/api/join', sub, { displayName: 'Hugo' })).status).toBe(400);
  });

  it('leaves an anonymous call to the mount’s 401', async () => {
    expect((await app.request('/api/join', { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('admits an unverified address only under the break-glass', async () => {
    const sub = await member('ines@example.com', false);
    expect((await joinAs(appWith({ OIDC_ALLOW_UNVERIFIED_EMAIL: 'true' }), sub, 'ines@example.com')).status).toBe(200);
  });
});

describe('a share reaches only the person who verified the address', () => {
  async function shareTo(email: string): Promise<Response> {
    const list = (await (await send(app, '/api/lists', 'ada', { name: `for ${email}` })).json()) as { id: string };
    return send(app, `/api/lists/${list.id}/shares`, 'ada', { email });
  }

  it('shares to the member who joined with their verified address', async () => {
    const sub = await member('jon@example.com', true);
    expect((await joinAs(app, sub, 'jon@example.com')).status).toBe(200);
    expect((await shareTo('jon@example.com')).status).toBe(200);
  });

  it('an address nobody verified stays unclaimed, so a share to it finds nobody', async () => {
    const sub = await member('karin@example.com', true);
    expect((await joinAs(app, sub, 'lars@example.com')).status).toBe(403);
    expect((await shareTo('lars@example.com')).status).toBe(404);
  });

  it('shares to the member who joined over MCP with their verified address', async () => {
    const sub = await member('mona@example.com', true);
    expect((await joinOverMcp(sub, 'mona@example.com')).isError).toBeUndefined();
    expect((await shareTo('mona@example.com')).status).toBe(200);
  });

  it('refuses the same claim over MCP, so the share still finds nobody', async () => {
    const sub = await member('nils@example.com', true);
    const result = await joinOverMcp(sub, 'olga@example.com');
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('join with the verified email address you signed in with');
    expect((await shareTo('olga@example.com')).status).toBe(404);
  });

  it('refuses an unverified address over MCP too', async () => {
    const sub = await member('petra@example.com', false);
    const result = await joinOverMcp(sub, 'petra@example.com');
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not verified');
  });
});
