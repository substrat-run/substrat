/**
 * The per-install identity reaches a hosted Manyfold (#2201), through the deployed worker.
 *
 * `src/worker.ts` already read a delivered `substrat:auth` back from the tenant's identity
 * directory; what it lacked was the DELIVERY, so `/internal/configure` answered 501 and a hosted
 * Manyfold kept its binding-default OIDC (`OIDC_ISSUER` in `vitest.workers.config.ts`). This
 * drives the real mounted route as the platform does, then asks the worker which issuer it signs
 * a login in at, and holds:
 *
 *   - a delivery switches that install to the per-install issuer: login goes there, a session it
 *     signed is accepted, and a bearer from the binding-default issuer no longer is;
 *   - the twin: with nothing delivered (or a delivery that is not a usable OIDC choice) the
 *     binding default still serves, and a bearer from it signs in;
 *   - the config is per SCOPE: a delivery for one site is not read for a sibling site;
 *   - a refused issuer is a 503 for THAT install only, never a silent fall back;
 *   - the route refuses a caller without the platform secret, and stores nothing for it.
 */
import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { principalId, scopeId, tenantId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';

const BINDING_ISSUER = 'https://binding-issuer.test';
const owner = principalId.parse(ulid());
const INSTALLED = JSON.parse(env.TEST_INSTALL_ENTITLEMENTS) as string[];
const entitlements = INSTALLED.map((entitlementKey) => ({
  entitlementKey,
  expiresAt: null,
  quota: null,
  plan: null,
  grantedAt: null,
  grantedBy: null,
}));

const b64u = (v: ArrayBuffer | string) =>
  btoa(typeof v === 'string' ? v : String.fromCharCode(...new Uint8Array(v)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** An issuer that serves discovery + a JWKS from the stubbed `fetch`, and mints bearers it signed. */
async function fakeIssuer(origin: string) {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  const mint = async (sub: string): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64u(JSON.stringify({ alg: 'ES256', kid: 'k1' }))}.${b64u(JSON.stringify({ iss: origin, sub, iat: now, exp: now + 600 }))}`;
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(unsigned));
    return `${unsigned}.${b64u(sig)}`;
  };
  const serve = (url: string): Response | null => {
    if (url === `${origin}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: origin,
        jwks_uri: `${origin}/jwks`,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
      });
    }
    if (url === `${origin}/jwks`) return Response.json({ keys: [jwk] });
    return null;
  };
  return { mint, serve };
}

type Issuer = Awaited<ReturnType<typeof fakeIssuer>>;
let issuers: Issuer[] = [];
/** Stub `fetch` so every fake issuer answers; anything else is a 404 the test would notice. */
function stubIssuers(...list: Issuer[]): void {
  issuers = list;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const i of issuers) {
      const r = i.serve(url);
      if (r) return r;
    }
    return new Response('not found', { status: 404 });
  });
}

const platformHeaders = (secret?: string): Record<string, string> => ({
  'content-type': 'application/json',
  ...(secret ? { 'x-substrat-platform': secret } : {}),
});
/** `secret` is the platform's by default; `null` presents none (an `undefined` default would swallow it). */
const platform = (path: string, body: unknown, secret: string | null = env.PLATFORM_SECRET) =>
  SELF.fetch(`https://manyfold.test${path}`, {
    method: 'POST',
    headers: platformHeaders(secret ?? undefined),
    body: JSON.stringify(body),
  });

interface Install {
  t: TenantId;
  s: ScopeId;
}

async function install(tenant: TenantId = tenantId.parse(ulid())): Promise<Install> {
  const i = { t: tenant, s: scopeId.parse(ulid()) };
  const slug = `site-${ulid().toLowerCase()}`;
  expect((await platform('/internal/provision', { tenantId: i.t, scopeId: i.s, owner, entitlements, slug, name: slug })).status).toBe(201);
  return i;
}

const choice = (issuer: string, i: Install) => JSON.stringify({ mode: 'oidc', issuer, clientId: `client-${i.s}`, clientSecret: 'secret-1' });
const deliver = (i: Install, value: string, key = 'substrat:auth') =>
  platform('/internal/configure', { tenantId: i.t, scopeId: i.s, entries: [{ key, value }] });

const routed = (i: Install, extra: Record<string, string> = {}): Record<string, string> => ({
  'x-substrat-tenant': i.t,
  'x-substrat-scope': i.s,
  'x-substrat-router': env.ROUTER_SECRET,
  ...extra,
});
const get = (i: Install, path: string, extra: Record<string, string> = {}) =>
  SELF.fetch(`https://manyfold.test${path}`, { headers: routed(i, extra), redirect: 'manual' });

/** The `sub` the worker resolves a bearer to (`/api/session` is the provider's `resolve`), or null. */
async function sessionOf(i: Install, token: string): Promise<{ sub: string } | null> {
  const res = await get(i, '/api/session', { authorization: `Bearer ${token}` });
  expect(res.status).toBe(200);
  return (await res.json()) as { sub: string } | null;
}

// Made once: the worker caches an issuer's discovery and JWKS for the isolate's life, so a key
// regenerated per test would be signed with and verified against different ones.
let binding: Issuer;
let perInstall: Issuer;
beforeAll(async () => {
  binding = await fakeIssuer(BINDING_ISSUER);
  perInstall = await fakeIssuer('https://team-auth.test');
});
beforeEach(() => stubIssuers(binding, perInstall));
afterEach(() => vi.unstubAllGlobals());

describe('/internal/configure on a hosted manyfold (#2201)', () => {
  it('stores a delivered config for the scope it names, and answers what the platform expects', async () => {
    const a = await install();
    const res = await deliver(a, choice('https://team-auth.test', a));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scopeId: a.s, entries: 1 });
    expect(Object.keys(await env.AUTH.get(env.AUTH.idFromName(a.t)).getScopeConfig(a.s))).toEqual(['substrat:auth']);
  });

  it.each([
    ['no platform secret', null],
    ['a wrong platform secret', 'not-the-secret'],
  ])('refuses %s, and stores nothing', async (_name, secret) => {
    const a = await install();
    const res = await platform(
      '/internal/configure',
      { tenantId: a.t, scopeId: a.s, entries: [{ key: 'substrat:auth', value: choice('https://team-auth.test', a) }] },
      secret,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(501);
    expect(await env.AUTH.get(env.AUTH.idFromName(a.t)).getScopeConfig(a.s)).toEqual({});
    // The refusal is the guard's, not an absent route: the same call with the secret goes through.
    expect((await deliver(a, choice('https://team-auth.test', a))).status).toBe(200);
  });
});

describe('a delivered substrat:auth switches the install to the per-install issuer (#2201)', () => {
  it('twin: nothing delivered, the binding default serves and a bearer from it signs in', async () => {
    const a = await install();
    expect(await (await get(a, '/api/auth/login')).json()).toMatchObject({ provider: 'oidc', issuer: BINDING_ISSUER });
    expect(await sessionOf(a, await binding.mint('sub-ann'))).toMatchObject({ sub: 'sub-ann' });
    expect(await sessionOf(a, await perInstall.mint('sub-ann'))).toBeNull();
  });

  it('delivered: login goes to the per-install issuer, its bearer signs in, the binding default no longer does', async () => {
    const a = await install();
    expect((await deliver(a, choice('https://team-auth.test', a))).status).toBe(200);
    const login = await get(a, '/api/auth/login');
    expect(login.status).toBe(302);
    expect(login.headers.get('location')).toMatch(/^https:\/\/team-auth\.test\/authorize\?/);
    expect(await sessionOf(a, await perInstall.mint('sub-ann'))).toMatchObject({ sub: 'sub-ann' });
    expect(await sessionOf(a, await binding.mint('sub-ann'))).toBeNull();
  });

  it.each([
    ['an entry that is not an OIDC choice', JSON.stringify({ mode: 'builtin' })],
    ['an entry that is not JSON', 'not json'],
  ])('twin: %s reads as nothing delivered, and the binding default still serves', async (_name, value) => {
    const a = await install();
    expect((await deliver(a, value)).status).toBe(200);
    expect(await (await get(a, '/api/auth/login')).json()).toMatchObject({ issuer: BINDING_ISSUER });
    expect(await sessionOf(a, await binding.mint('sub-ann'))).toMatchObject({ sub: 'sub-ann' });
  });

  it('a refused issuer is a 503 for that install, not a fall back to the binding default', async () => {
    const a = await install();
    expect((await deliver(a, choice('http://insecure-issuer.test', a))).status).toBe(200);
    expect((await get(a, '/api/auth/login')).status).toBe(503);
    expect((await get(a, '/api/session', { authorization: `Bearer ${await binding.mint('sub-ann')}` })).status).toBe(503);
    // Positive twin: another install of the tenant's neighbour is untouched.
    const other = await install();
    expect(await sessionOf(other, await binding.mint('sub-ann'))).toMatchObject({ sub: 'sub-ann' });
  });
});

describe('the config is per scope: sites of one tenant (#2201)', () => {
  it('a delivery for site A is not read for site B, and a site with none falls back rather than locking out', async () => {
    const a = await install();
    const b = await install(a.t); // same tenant, so the same identity DO
    expect((await deliver(a, choice('https://team-auth.test', a))).status).toBe(200);
    // A: the per-install issuer.
    expect((await get(a, '/api/auth/login')).headers.get('location')).toMatch(/^https:\/\/team-auth\.test\//);
    expect(await sessionOf(a, await perInstall.mint('sub-ann'))).toMatchObject({ sub: 'sub-ann' });
    // B, routed on its own: still the binding default, and it signs in.
    expect(await (await get(b, '/api/auth/login')).json()).toMatchObject({ issuer: BINDING_ISSUER });
    expect(await sessionOf(b, await binding.mint('sub-bob'))).toMatchObject({ sub: 'sub-bob' });
    expect(await sessionOf(b, await perInstall.mint('sub-bob'))).toBeNull();
  });

  it('and the other way round: B\'s delivery does not reach A', async () => {
    const a = await install();
    const b = await install(a.t);
    expect((await deliver(b, choice('https://team-auth.test', b))).status).toBe(200);
    expect(await (await get(a, '/api/auth/login')).json()).toMatchObject({ issuer: BINDING_ISSUER });
    expect((await get(b, '/api/auth/login')).headers.get('location')).toMatch(/^https:\/\/team-auth\.test\//);
  });

  it.each([
    ['x-scope', (o: Install, _slug: string) => ({ 'x-scope': o.s })],
    ['x-site', (_o: Install, slug: string) => ({ 'x-site': slug })],
  ])('a site picked with %s keeps the ROUTED site\'s identity, on /api/session and on /api/me', async (_name, select) => {
    // Routed home A has a delivery; the selected sibling B has none. The login is the routed site's,
    // so who you are cannot depend on which site you look at; only the principal is B's.
    const home = await install();
    const other = await install(home.t);
    expect((await deliver(home, choice('https://team-auth.test', home))).status).toBe(200);
    const slug = (await env.AUTH.get(env.AUTH.idFromName(home.t)).listSites()).find((x) => x.scopeId === other.s)!.slug;
    const sel = select(other, slug);
    const bearer = (token: string) => ({ authorization: `Bearer ${token}`, ...sel });
    const me = async (token: string) => (await (await get(home, '/api/me', bearer(token))).json()) as { key?: string; status?: string };
    // The home's issuer signs in, and the first sign-in claims the SELECTED site's open owner seat.
    expect((await (await get(home, '/api/session', bearer(await perInstall.mint('sub-ann')))).json())).toMatchObject({ sub: 'sub-ann' });
    expect((await me(await perInstall.mint('sub-ann'))).key).toBeDefined();
    // The selected site's binding default is NOT consulted: its issuer's token resolves to nobody.
    expect(await (await get(home, '/api/session', bearer(await binding.mint('sub-bob')))).json()).toBeNull();
    const bob = await me(await binding.mint('sub-bob'));
    expect(bob.key).toBeUndefined();
  });
});
