/**
 * The shared invite routes (#1150), driven over HTTP against stand-ins for everything a
 * vertical supplies: a directory (an in-memory copy of the identity DO's invite half), a
 * host that records grants, an auth provider that reads a bearer subject, and an admin gate
 * that reads a header. What is asserted is the contract the three copies used to agree on
 * by coincidence — the status codes, the shapes, that only the token's HASH reaches the
 * directory, and that the role is granted BEFORE the invite is recorded.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { mountInviteRoutes, type InviteDirectory } from '../src/invite-routes.js';
import { sha256Hex } from '../src/owner-claim-link.js';
import type { AuthProvider, AuthSubject } from '../src/provider.js';

interface Env {
  SUBJECTS: Record<string, AuthSubject>;
}

type Invite = { principal: string; roleKey: string; email: string | null; createdAt: number; tokenHash: string };

/** The identity DO's invite half, in memory: rows keyed by principal, bound subjects beside them. */
class MemoryDirectory implements InviteDirectory {
  readonly invites = new Map<string, Invite>();
  readonly bound = new Map<string, string>();
  constructor(readonly log: string[]) {}
  async createInvite(scopeId: string, principal: string, roleKey: string, email: string | null, tokenHash: string) {
    this.log.push(`createInvite ${scopeId} ${principal} ${roleKey}`);
    this.invites.set(principal, { principal, roleKey, email, createdAt: 1_700_000_000_000, tokenHash });
  }
  async listInvites() {
    return [...this.invites.values()].map(({ tokenHash: _hash, ...row }) => row);
  }
  async revokeInvite(_scopeId: string, principal: string) {
    this.invites.delete(principal);
  }
  async claimInvite(_scopeId: string, sub: string, tokenHash: string) {
    const row = [...this.invites.values()].find((r) => r.tokenHash === tokenHash);
    if (!row) return null;
    this.invites.delete(row.principal);
    this.bound.set(sub, row.principal);
    return row.principal;
  }
}

const NODE = { tenantId: 'tenant-a', scopeId: 'scope-1' };
const ROLES = ['admin', 'editor'] as const;

let log: string[];
let directory: MemoryDirectory;
let app: Hono<{ Bindings: Env }>;

const env = (): Env => ({
  SUBJECTS: {
    'tok-owner': { sub: 'sub-owner', email: 'owner@acme.example', name: 'Owner' },
    'tok-newcomer': { sub: 'sub-newcomer', email: 'new@acme.example', name: 'Newcomer' },
  },
});

const provider = (env: Env): AuthProvider => ({
  resolve: async (headers) => {
    const bearer = headers.get('authorization')?.replace(/^Bearer /, '');
    return (bearer && env.SUBJECTS[bearer]) || null;
  },
  handle: async () => new Response(null, { status: 404 }),
});

beforeEach(() => {
  log = [];
  directory = new MemoryDirectory(log);
  app = new Hono<{ Bindings: Env }>();
  // A deliberately naive envelope: an HTTPException keeps its status and ANYTHING else is a
  // 500. That is what pins the mount's promise — every error it raises itself is an
  // HTTPException — because a `ZodError` or a `SyntaxError` escaping would show up here as
  // a 500, where a vertical's own envelope might have papered over it.
  app.onError((err, c) => (err instanceof HTTPException ? err.getResponse() : c.json({ error: err.message }, 500)));
  mountInviteRoutes(app, {
    nodeFor: async () => NODE,
    // The vertical's gate: in the demos a whoami; here the caller says so with a header.
    requireAdmin: async (c) => {
      if (!c.req.header('authorization')) throw new HTTPException(401, { message: 'unauthorized' });
      if (c.req.header('x-test-admin') !== 'yes') throw new HTTPException(403, { message: 'only an admin can manage invites' });
    },
    roles: ROLES,
    directory: () => directory,
    assignScopeRole: async (_env, scopeId, principal, roleKey) => {
      log.push(`assignScopeRole ${scopeId} ${principal} ${roleKey}`);
    },
    revokeScopeRole: async (_env, scopeId, principal, roleKey) => {
      log.push(`revokeScopeRole ${scopeId} ${principal} ${roleKey}`);
    },
    authProvider: async (env) => provider(env),
  });
});

const admin = { authorization: 'Bearer tok-owner', 'x-test-admin': 'yes' };
const json = (body: unknown, headers: Record<string, string> = admin) => ({
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('mountInviteRoutes', () => {
  it('lists the vertical roles and the open invites, for an admin only', async () => {
    const res = await app.request('http://app.example/api/invites', { headers: admin }, env());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ roles: ['admin', 'editor'], invites: [] });

    const nobody = await app.request('http://app.example/api/invites', {}, env());
    expect(nobody.status).toBe(401);
    const member = await app.request('http://app.example/api/invites', { headers: { authorization: 'Bearer tok-owner' } }, env());
    expect(member.status).toBe(403);
  });

  it('creates an invite: grants the role first, stores only the token hash, returns the accept link', async () => {
    const res = await app.request('http://app.example/api/invites', json({ email: 'new@acme.example', roleKey: 'editor' }), env());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { principal: string; roleKey: string; email: string | null; acceptUrl: string };
    expect(body.principal).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.roleKey).toBe('editor');
    expect(body.email).toBe('new@acme.example');

    // The link opens the app at the request's own origin, and carries the plaintext token.
    const url = new URL(body.acceptUrl);
    expect(url.origin).toBe('http://app.example');
    expect(url.pathname).toBe('/');
    const token = url.searchParams.get('invite')!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // The directory holds the HASH, never the token.
    const row = directory.invites.get(body.principal)!;
    expect(row.tokenHash).toBe(await sha256Hex(token));
    expect(row.tokenHash).not.toBe(token);

    // Grant before row: an invite whose principal holds nothing would bind a teammate to no access.
    expect(log).toEqual([
      `assignScopeRole scope-1 ${body.principal} editor`,
      `createInvite scope-1 ${body.principal} editor`,
    ]);

    const list = (await (await app.request('http://app.example/api/invites', { headers: admin }, env())).json()) as {
      invites: Array<{ principal: string; email: string | null }>;
    };
    expect(list.invites).toEqual([{ principal: body.principal, roleKey: 'editor', email: 'new@acme.example', createdAt: 1_700_000_000_000 }]);
  });

  it('refuses a role the vertical does not declare, before anything is granted or recorded', async () => {
    const res = await app.request('http://app.example/api/invites', json({ roleKey: 'owner' }), env());
    expect(res.status).toBe(400);
    expect(log).toEqual([]);
    expect(directory.invites.size).toBe(0);
  });

  it('needs no email; a body that does not fit is a 400 the mount raises itself, not a throw the vertical must catch', async () => {
    const res = await app.request('http://app.example/api/invites', json({ roleKey: 'admin' }), env());
    expect(res.status).toBe(201);
    expect(((await res.json()) as { email: string | null }).email).toBeNull();
    expect(log).toHaveLength(2); // one grant, one row

    // A schema miss and a body that is not JSON at all both come out as an HTTPException
    // 400 naming the problem — under this suite's envelope a bare ZodError or SyntaxError
    // would be a 500 — and nothing was granted on the way.
    const bad = await app.request('http://app.example/api/invites', json({ email: 'x' }), env());
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/roleKey/);
    const notJson = await app.request('http://app.example/api/invites', {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: '{not json',
    }, env());
    expect(notJson.status).toBe(400);
    expect(await notJson.text()).toMatch(/must be JSON/);
    expect(log).toHaveLength(2);
  });

  it('takes the grant back when the invite row cannot be written, so a retry mints no orphan', async () => {
    // The grant and the row live in two Durable Objects with no transaction between
    // them. A create that fails after the grant would otherwise leave a principal nobody
    // can bind to holding a role — and every retry another one.
    directory.createInvite = async () => {
      throw new Error('directory unavailable');
    };
    const res = await app.request('http://app.example/api/invites', json({ roleKey: 'admin' }), env());
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/directory unavailable/); // the ORIGINAL failure, not the revoke's
    expect(log.map((l) => l.split(' ')[0])).toEqual(['assignScopeRole', 'revokeScopeRole']);
    const [grant, revoke] = log;
    // The same (scope, principal, role) the grant named.
    expect(revoke!.replace('revokeScopeRole', 'assignScopeRole')).toBe(grant);
    expect(directory.invites.size).toBe(0);
  });

  it('revokes an invite, for an admin only', async () => {
    const created = (await (await app.request('http://app.example/api/invites', json({ roleKey: 'admin' }), env())).json()) as {
      principal: string;
    };
    const member = await app.request(
      `http://app.example/api/invites/${created.principal}/revoke`,
      { method: 'POST', headers: { authorization: 'Bearer tok-owner' } },
      env(),
    );
    expect(member.status).toBe(403);
    expect(directory.invites.has(created.principal)).toBe(true);

    const res = await app.request(`http://app.example/api/invites/${created.principal}/revoke`, { method: 'POST', headers: admin }, env());
    expect(res.status).toBe(204);
    expect(directory.invites.has(created.principal)).toBe(false);
  });

  it('accepts an invite once, for a signed-in subject, by the token from the accept link', async () => {
    const created = (await (await app.request('http://app.example/api/invites', json({ roleKey: 'editor' }), env())).json()) as {
      principal: string;
      acceptUrl: string;
    };
    const token = new URL(created.acceptUrl).searchParams.get('invite')!;

    // Not signed in: 401, and nothing is bound.
    const anon = await app.request('http://app.example/api/accept-invite', json({ token }, {}), env());
    expect(anon.status).toBe(401);
    expect(directory.bound.size).toBe(0);

    // A wrong token: one answer, nothing bound.
    const wrong = await app.request('http://app.example/api/accept-invite', json({ token: 'nope' }, { authorization: 'Bearer tok-newcomer' }), env());
    expect(wrong.status).toBe(400);
    expect(directory.bound.size).toBe(0);

    // The right token binds the subject to the pre-minted principal — no admin needed.
    const ok = await app.request('http://app.example/api/accept-invite', json({ token }, { authorization: 'Bearer tok-newcomer' }), env());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, principal: created.principal });
    expect(directory.bound.get('sub-newcomer')).toBe(created.principal);

    // Used up: the same token answers exactly as a wrong one does.
    const again = await app.request('http://app.example/api/accept-invite', json({ token }, { authorization: 'Bearer tok-owner' }), env());
    expect(again.status).toBe(400);
  });

  it('builds the accept link on a supplied origin when the vertical has one', async () => {
    const other = new Hono<{ Bindings: Env }>();
    mountInviteRoutes(other, {
      nodeFor: () => NODE,
      requireAdmin: async () => undefined,
      roles: ROLES,
      directory: () => directory,
      assignScopeRole: async () => undefined,
      authProvider: async (env) => provider(env),
      revokeScopeRole: async () => undefined,
      // With the trailing slash a configured origin so often carries: the link must not
      // come out as `https://host//?invite=…`, which is a different SPA path.
      origin: () => 'https://public.acme.example/',
    });
    const res = await other.request('http://internal.local/api/invites', json({ roleKey: 'admin' }), env());
    expect(((await res.json()) as { acceptUrl: string }).acceptUrl).toMatch(/^https:\/\/public\.acme\.example\/\?invite=[0-9a-f]{64}$/);
  });
});
