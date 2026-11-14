import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { scopeId, tenantId, type SeededPersona } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { pkceS256, type OidcEnv, type SessionUser } from '@substrat-run/oidc-rp';
import { mountPersonaIssuer, type PersonaIssuerDO } from '../src/persona-issuer.js';

/**
 * #3108: the persona issuer, driven as a seeded preview's deployment drives it — discovery, the
 * picker, the code exchange, and the ID token verified against the JWKS — over the real Durable
 * Object and its real key. The control plane around it (the session, the team, the preview's
 * personas) is faked, so each refusal is the issuer's own.
 */
const ORIGIN = 'https://cp.test';
const TENANT = tenantId.parse(ulid());
const PREVIEW = scopeId.parse(ulid());
const CALLBACK = 'https://todo--studio.acme.global.substrat.run/api/auth/callback';
const ANNA: SeededPersona = { sub: 'dev|anna', name: 'Anna', email: 'anna@example.test', role: 'admin' };
const MEMBER: SessionUser = { id: 'user-member' };
const OUTSIDER: SessionUser = { id: 'user-outsider' };

const issuer = `${ORIGIN}/persona/${PREVIEW}`;
const ns = (env as unknown as { PERSONA_ISSUER: DurableObjectNamespace<PersonaIssuerDO> }).PERSONA_ISSUER;
const stub = () => ns.get(ns.idFromName('persona-issuer-test'));
let active = true;
/** A member taken off the team after the studio minted their ticket. */
let ousted = false;

/** The issuer mounted with a faked control plane: the session is a header naming the user, the studio's credential another. */
const mount = (ticketTtlMs?: number) => {
  const app = new Hono<{ Bindings: object }>();
  mountPersonaIssuer(app, {
    stub,
    origin: () => ORIGIN,
    oidc: () => ({ SESSION_SECRET: 'test-session-secret-32-bytes-min-xxxxx' }) as OidcEnv,
    session: async (_e, headers) => (headers.get('x-test-user') === MEMBER.id ? MEMBER : headers.get('x-test-user') === OUTSIDER.id ? OUTSIDER : null),
    isMember: async (_e, user, t) => user.id === MEMBER.id && t === TENANT && !ousted,
    personas: async () => (active ? [ANNA] : null),
    active: async () => active,
    service: async (_e, request) => request.headers.get('x-service-token') === 'studio',
    ...(ticketTtlMs === undefined ? {} : { ticketTtlMs }),
  });
  return (path: string, init: RequestInit = {}) => app.request(`${ORIGIN}${path}`, { redirect: 'manual', ...init }, {});
};
const call = mount();

let secret: string;
beforeAll(async () => {
  secret = await stub().register(PREVIEW, TENANT, CALLBACK);
});

/** The deployment's half: an authorize URL with a fresh PKCE pair, as `beginLogin` builds it. */
async function begin(over: Record<string, string> = {}) {
  const verifier = `verifier-${ulid()}`;
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: PREVIEW,
    redirect_uri: CALLBACK,
    state: 'st-1',
    nonce: 'n-1',
    code_challenge: await pkceS256(verifier),
    code_challenge_method: 'S256',
    ...over,
  });
  return { verifier, path: `/persona/${PREVIEW}/authorize?${q}` };
}

/** Pick a persona on the picker as `user`, answering the redirect the issuer sends back. */
async function pick(path: string, sub: string, user = MEMBER.id, origin = ORIGIN) {
  const html = await (await call(path, { headers: { 'x-test-user': user } })).text();
  const request = /name="request" value="([^"]+)"/.exec(html)![1]!.replace(/&amp;/g, '&');
  return call(`/persona/${PREVIEW}/authorize`, {
    method: 'POST',
    headers: { 'x-test-user': user, origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request, sub }),
  });
}

const exchange = (code: string, verifier: string, clientSecret = secret) =>
  call(`/persona/${PREVIEW}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: PREVIEW, client_secret: clientSecret, code_verifier: verifier }),
  });

/** The studio minting a ticket for `externalId` to be `sub` in `scope`, over its service credential. */
const mintTicket = (externalId: string, sub = ANNA.sub, scope: string = PREVIEW, token = 'studio', via = call) =>
  via(`/internal/builder/persona/${scope}/ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-token': token },
    body: JSON.stringify({ externalId, sub }),
  });

/** The frame's walk: `/enter` with the ticket, then the deployment's `/authorize` carrying the entry cookie. */
async function enter(ticketUrl: string, via = call) {
  const entered = await via(new URL(ticketUrl).pathname + new URL(ticketUrl).search);
  const cookie = entered.headers.get('set-cookie');
  return { entered, cookie, entry: cookie && /^substrat_persona_entry=([^;]*)/.exec(cookie)![1]! };
}

describe('the persona issuer (#3108)', () => {
  it('signs a team member in as a persona: discovery, picker, a single-use code, and a token the JWKS verifies', async () => {
    const discovery = (await (await call(`/persona/${PREVIEW}/.well-known/openid-configuration`)).json()) as Record<string, string>;
    expect(discovery).toMatchObject({ issuer, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    expect(await stub().register(PREVIEW, TENANT, CALLBACK)).toBe(secret); // the same secret on every push

    const { path, verifier } = await begin();
    expect((await call(path)).headers.get('location')).toBe(`/api/auth/login?returnTo=${encodeURIComponent(path)}`);
    const picked = await pick(path, ANNA.sub);
    expect(picked.status).toBe(302);
    const back = new URL(picked.headers.get('location')!);
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    expect(back.searchParams.get('state')).toBe('st-1');
    const code = back.searchParams.get('code')!;

    const res = await exchange(code, verifier);
    expect(res.status).toBe(200);
    const { id_token } = (await res.json()) as { id_token: string };
    const jwks = createLocalJWKSet((await (await call(`/persona/${PREVIEW}/jwks`)).json()) as never);
    const { payload } = await jwtVerify(id_token, jwks, { issuer, audience: PREVIEW });
    expect(payload).toMatchObject({ sub: ANNA.sub, email: ANNA.email, email_verified: true, name: 'Anna', nonce: 'n-1' });

    expect(((await (await exchange(code, verifier)).json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('refuses whoever is not on the team, a callback not the preview\'s own, a cross-site pick, and a gone preview', async () => {
    const { path, verifier } = await begin();
    expect((await call(path, { headers: { 'x-test-user': OUTSIDER.id } })).status).toBe(403);
    const elsewhere = await begin({ redirect_uri: 'https://evil.test/api/auth/callback' });
    const refused = await call(elsewhere.path, { headers: { 'x-test-user': MEMBER.id } });
    expect([refused.status, refused.headers.get('location')]).toEqual([400, null]);
    expect((await pick(path, ANNA.sub, MEMBER.id, 'https://evil.test')).status).toBe(403);
    expect((await pick(path, 'dev|nobody')).status).toBe(400);

    const code = new URL((await pick(path, ANNA.sub)).headers.get('location')!).searchParams.get('code')!;
    expect((await exchange(code, verifier, 'wrong')).status).toBe(401);
    active = false;
    try {
      expect(((await (await exchange(code, verifier)).json()) as { error: string }).error).toBe('invalid_grant');
      expect((await call(path, { headers: { 'x-test-user': MEMBER.id } })).status).toBe(410);
    } finally {
      active = true;
    }
  });

  it('refuses a code exchanged without its PKCE verifier', async () => {
    const { path } = await begin();
    const code = new URL((await pick(path, ANNA.sub)).headers.get('location')!).searchParams.get('code')!;
    expect(((await (await exchange(code, 'not-the-verifier')).json()) as { error_description: string }).error_description).toBe('PKCE verification failed');
  });
});

describe("signing in inside the studio's frame (#3145)", () => {
  it('turns a ticket into a code for its persona, with no page rendered: enter, the preview\'s login, authorize, callback', async () => {
    const personas = await call(`/internal/builder/persona/${PREVIEW}/personas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': 'studio' },
      body: JSON.stringify({ externalId: MEMBER.id }),
    });
    expect(((await personas.json()) as { personas: SeededPersona[] }).personas.map((p) => p.sub)).toEqual([ANNA.sub]);

    const minted = await mintTicket(MEMBER.id);
    const { url, expiresIn } = (await minted.json()) as { url: string; expiresIn: number };
    expect(expiresIn).toBe(60); // the production default: a minute
    expect(url.startsWith(`${issuer}/enter?ticket=`)).toBe(true);

    const { entered, cookie, entry } = await enter(url);
    expect([entered.status, entered.headers.get('location')]).toEqual([302, new URL('/api/auth/login', CALLBACK).toString()]);
    expect(cookie).toBe(`substrat_persona_entry=${entry}; Path=/persona/${PREVIEW}; Max-Age=60; HttpOnly; Secure; SameSite=None; Partitioned`);

    // No session at all: the entry is what names the person and the persona.
    const { path, verifier } = await begin();
    const authorized = await call(path, { headers: { cookie: `substrat_persona_entry=${entry}` } });
    expect(authorized.status).toBe(302);
    expect(authorized.headers.get('content-type')).toBeNull();
    expect(authorized.headers.get('set-cookie')).toContain('substrat_persona_entry=; Path=/persona/');
    const back = new URL(authorized.headers.get('location')!);
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    const { id_token } = (await (await exchange(back.searchParams.get('code')!, verifier)).json()) as { id_token: string };
    const jwks = createLocalJWKSet((await (await call(`/persona/${PREVIEW}/jwks`)).json()) as never);
    expect((await jwtVerify(id_token, jwks, { issuer, audience: PREVIEW })).payload.sub).toBe(ANNA.sub);

    // Both are single-use: the ticket at /enter, the entry at /authorize.
    expect((await enter(url)).entered.status).toBe(400);
    expect((await call(path, { headers: { cookie: `substrat_persona_entry=${entry}` } })).status).toBe(400);
  });

  it('refuses a ticket to whoever is not on the team, to anyone without the studio\'s credential, and for a persona not offered', async () => {
    expect((await mintTicket(OUTSIDER.id)).status).toBe(403);
    expect((await mintTicket(MEMBER.id, ANNA.sub, PREVIEW, 'not-the-studio')).status).toBe(403);
    expect((await mintTicket(MEMBER.id, 'dev|nobody')).status).toBe(400);
  });

  it('asks the team again at authorize: a person taken off it after the ticket is refused', async () => {
    const { url } = (await (await mintTicket(MEMBER.id)).json()) as { url: string };
    const { entry } = await enter(url);
    const { path } = await begin();
    ousted = true;
    try {
      expect((await call(path, { headers: { cookie: `substrat_persona_entry=${entry}` } })).status).toBe(403);
    } finally {
      ousted = false;
    }
  });

  it('holds a ticket to its own preview, its own step, and its minute', async () => {
    const other = scopeId.parse(ulid());
    await stub().register(other, TENANT, 'https://todo--other.acme.global.substrat.run/api/auth/callback');
    const { url } = (await (await mintTicket(MEMBER.id)).json()) as { url: string };
    const elsewhere = new URL(url);
    elsewhere.pathname = `/persona/${other}/enter`;
    expect((await enter(elsewhere.toString())).entered.status).toBe(400);

    // A ticket is not an entry: the frame cannot skip /enter with it.
    const skipped = (await (await mintTicket(MEMBER.id)).json()) as { url: string };
    const { path } = await begin();
    expect((await call(path, { headers: { cookie: `substrat_persona_entry=${new URL(skipped.url).searchParams.get('ticket')}` } })).status).toBe(400);

    const expiring = mount(0);
    const stale = (await (await mintTicket(MEMBER.id, ANNA.sub, PREVIEW, 'studio', expiring)).json()) as { url: string };
    expect((await enter(stale.url, expiring)).entered.status).toBe(400);
  });

  it('still refuses to be framed: the picker sends frame-ancestors \'none\'', async () => {
    const { path } = await begin();
    const picker = await call(path, { headers: { 'x-test-user': MEMBER.id } });
    expect(picker.status).toBe(200);
    expect(picker.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});
