/**
 * Member invites on a dev server (K-61 phase 3): a person invited locally gets in locally. The
 * invite is made through the routes the worker door mounts, filed in a real SQLite file, and the
 * invitee — signed in through this issuer, with no link in the pool — is admitted by the address it
 * verified, linked in the pool, and resolved as anyone is from then on. The host is a stand-in that
 * records what it is asked: the scope's exchange by id is held by the adapters' contract suites.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import type { CapabilityId, PrincipalId, ScopeId, TenantId } from '@substrat-run/contracts';
import { createDevIssuer } from '../src/issuer.js';
import { devLogin } from '../src/harness.js';
import { devMemberInvites, type DevInviteHost } from '../src/member-invites.js';

// Loopback, as the real dev issuer is: the relying party accepts a plain-http issuer only there.
const ISSUER = 'http://localhost:18879';
const app = createDevIssuer({
  personas: [
    { sub: 'dev|owen', name: 'Owen', email: 'owen@example.test' },
    { sub: 'dev|cleo', name: 'Cleo', email: 'Cleo@Example.test' },
  ],
  allowedRedirectPrefixes: [],
});

let realFetch: typeof globalThis.fetch;
beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as RequestInfo | URL, init);
    if (!req.url.startsWith(ISSUER)) return realFetch(input as RequestInfo, init);
    return Promise.resolve(app.fetch(req));
  }) as typeof globalThis.fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

/** A valid ULID from a small number: Crockford's alphabet has no I, L, O or U, so no words. */
const id = (n: number) => `01JZ${String(n).padStart(22, '0')}`;
const T1 = id(1) as TenantId;
const S1 = id(2) as ScopeId;
const OWEN = id(3) as PrincipalId;
const PROVIDER = 'oidc:dev-issuer';

const bearer = async (sub: string) => {
  const res = await app.fetch(
    new Request(`${ISSUER}/dev/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sub }) }),
  );
  return new Headers({ authorization: `Bearer ${((await res.json()) as { access_token: string }).access_token}` });
};

describe('member invites on a dev server (K-61 phase 3)', () => {
  /** The identity pool, as `linkIdentity` writes it: subject → where they live. */
  let pool: Map<string, { principal: PrincipalId; tenantId: TenantId; scopeId: ScopeId | null }>;
  let calls: string[];
  let host: DevInviteHost;
  let routes: Hono<{ Bindings: object }>;
  let login: ReturnType<typeof devLogin>;
  let admit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pool = new Map([['dev|owen', { principal: OWEN, tenantId: T1, scopeId: S1 }]]);
    calls = [];
    const minted = new Set<string>();
    host = {
      canAssign: async () => ({ covered: true, missing: [] }),
      assignScopeRoleBounded: async () => ({ covered: true, missing: [] }),
      revokeScopeRolesBounded: async () => ({ coverage: { covered: true, missing: [] }, revoked: ['rep'] }),
      mintBecomeCapabilityBounded: async (_t, _s, _caller, input) => {
        const link = id(100 + minted.size) as CapabilityId;
        minted.add(`${link} ${input.principal}`);
        return { ok: true, minted: { id: link, secret: `sbcap_${crypto.randomUUID()}`, expiresAt: input.expiresAt ?? null } };
      },
      revokeBecomeCapability: async () => ({ ok: true, revoked: true }),
      exchangeBecomeLinkById: async (tenantId, scopeId, link, label) => {
        calls.push(`exchange ${tenantId} ${scopeId} ${label}`);
        const entry = [...minted].find((m) => m.startsWith(`${link} `));
        if (!entry) return null;
        minted.delete(entry);
        return { kind: 'principal', capabilityId: link, principal: entry.split(' ')[1] as PrincipalId };
      },
      admin: {
        linkIdentity: async (_actor, link) => {
          calls.push(`link ${link.externalId}`);
          pool.set(link.externalId, { principal: link.principal, tenantId: link.tenantId, scopeId: link.scopeId ?? null });
        },
        unlinkIdentity: async (_actor, _tenant, principal) => {
          calls.push('unlink');
          for (const [sub, home] of pool) if (home.principal === principal) pool.delete(sub);
        },
      },
    };
    const members = devMemberInvites({ db: new Database(':memory:'), host, actor: 'actor' as never, provider: PROVIDER });
    admit = vi.fn(members.admit);
    login = devLogin({
      issuer: ISSUER,
      provider: PROVIDER,
      actor: 'actor' as never,
      directory: {
        listIdentityTenants: async (_actor, _provider, sub) => (pool.has(sub) ? [pool.get(sub)!.tenantId] : []),
        resolveIdentity: async (_tenant, _provider, sub) => pool.get(sub),
      },
      admit: admit as never,
    });
    routes = new Hono<{ Bindings: object }>();
    members.mount(routes, {
      login,
      scope: async () => ({}) as never,
      invites: { roles: ['rep'], send: async () => ({}), cancel: async () => ({}) },
    });
  });

  /** As Owen, the seeded owner: the routes read the caller from `login`, as the dev server's do. */
  const asOwen = async () => Object.fromEntries((await bearer('dev|owen')).entries());
  const invite = async (email: string) => {
    const res = await routes.request('/api/member-invites', {
      method: 'POST', headers: { ...(await asOwen()), 'content-type': 'application/json' }, body: JSON.stringify({ email, roleKey: 'rep' }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { principal: PrincipalId }).principal;
  };

  it('admits the invitee by their verified address on first sign-in, links them, and resolves them as anyone after', async () => {
    const invited = await invite('cleo@example.test');
    const headers = await bearer('dev|cleo');
    expect(await login.caller(headers)).toMatchObject({ principal: invited, tenantId: T1, scopeId: S1, verifiedEmail: 'Cleo@Example.test' });
    expect(calls).toEqual([`exchange ${T1} ${S1} member invite`, 'link dev|cleo']);
    expect(await login.caller(headers)).toMatchObject({ principal: invited });
    expect(admit).toHaveBeenCalledOnce();
  });

  it('answers nobody for a subject no invite names, and never asks about a seeded one', async () => {
    await invite('someone-else@example.test');
    admit.mockClear();
    expect(await login.caller(await bearer('dev|cleo'))).toBeNull();
    expect(await login.caller(await bearer('dev|owen'))).toMatchObject({ principal: OWEN });
    expect(admit).toHaveBeenCalledOnce();
    expect(calls).toEqual([]);
  });

  it('refuses an invite from someone signed in nowhere here, before anything is minted', async () => {
    const res = await routes.request('/api/member-invites', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x@example.test', roleKey: 'rep' }),
    });
    expect(res.status).toBe(401);
  });

  it('a withdrawn invite admits nobody: its row goes, and its principal is unlinked from the pool', async () => {
    const invited = await invite('cleo@example.test');
    const res = await routes.request(`/api/member-invites/${invited}/withdraw`, { method: 'POST', headers: await asOwen() });
    expect(res.status).toBe(204);
    expect(calls).toEqual(['unlink']);
    expect(await login.caller(await bearer('dev|cleo'))).toBeNull();
    expect(calls).toEqual(['unlink']);
  });
});
