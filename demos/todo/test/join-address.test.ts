/**
 * `POST /api/join` records the address `todo/share-list` finds a person by, so the address
 * must be the one the issuer verified this session controls (#1359). Driven through
 * `createApp` — the dev server's own wiring — with the issuer's answer stubbed, since the
 * claim is what is under test and the round-trip is the dev issuer's suite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { principalId } from '@substrat-run/contracts';
import type { AuthSubject, DevCaller } from '@substrat-run/dev-issuer';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import type { EmailIdentityEnv } from '@substrat-run/oidc-rp';
import { createApp } from '../src/app.js';
import { buildHost, seed, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;

/** Who each `x-test-sub` is, as the issuer answered and as the directory resolved them. */
const subjects = new Map<string, AuthSubject>();
const callers = new Map<string, DevCaller>();

function appWith(env: EmailIdentityEnv = {}): Hono {
  const sub = (h: Headers) => h.get('x-test-sub') ?? '';
  return createApp({
    host,
    env,
    login: {
      handle: async () => new Response(null, { status: 404 }),
      subject: async (h) => subjects.get(sub(h)) ?? null,
      caller: async (h) => callers.get(sub(h)) ?? null,
    },
  });
}

/** A new member of the seeded scope, signed in with `email` and the issuer's `verified` claim. */
async function member(email: string | null, verified: boolean | undefined): Promise<string> {
  const principal = principalId.parse(ulid());
  await host.admin.assignRole(world.staff, {
    principalId: principal,
    roleKey: 'member',
    node: { tenantId: world.tenant, scopeId: world.scope },
  });
  const sub = `sub-${principal}`;
  subjects.set(sub, { sub, email, name: null, ...(verified === undefined ? {} : { emailVerified: verified }) });
  callers.set(sub, { principal, tenantId: world.tenant, scopeId: world.scope, sub, display: sub });
  return sub;
}

const send = (app: Hono, path: string, sub: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'x-test-sub': sub }, body: JSON.stringify(body) });

const joinAs = (app: Hono, sub: string, email: string) => send(app, '/api/join', sub, { email, displayName: 'Someone' });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'todo-join-'));
  host = buildHost(dir);
  world = await seed(host);
  // Ada is seeded and joined; she is the one sharing.
  subjects.set('ada', { sub: 'ada', email: world.ada.email, name: 'Ada', emailVerified: true });
  callers.set('ada', { principal: world.ada.principal, tenantId: world.tenant, scopeId: world.scope, sub: 'ada', display: 'Ada' });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

let app: Hono;
beforeEach(() => {
  app = appWith();
});

async function message(res: Response): Promise<string> {
  return JSON.stringify(await res.json());
}

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
    expect(await message(res)).toContain('join with the verified email address you signed in with');
  });

  it.each([
    ['the issuer said false', false, 'not verified'],
    ['the session carries no claim', undefined, 'sign in again'],
  ] as const)('refuses its own address when %s', async (_label, verified, says) => {
    const email = `g-${String(verified)}@example.com`;
    const sub = await member(email, verified);
    const res = await joinAs(app, sub, email);
    expect(res.status).toBe(403);
    expect(await message(res)).toContain(says);
  });

  it('refuses a session that carries no address at all', async () => {
    const sub = await member(null, true);
    const res = await joinAs(app, sub, 'nobody@example.com');
    expect(res.status).toBe(403);
    expect(await message(res)).toContain('no email address');
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
});
