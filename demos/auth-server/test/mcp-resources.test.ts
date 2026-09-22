import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createLocalJWKSet, decodeJwt, type JSONWebKeySet } from 'jose';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { mcpResourceOf, scopeId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { mountOperations } from '@substrat-run/vertical-host';
import { oidcAuthProvider } from '@substrat-run/vertical-auth/oidc';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';
import type { SqlExec } from '../src/introspect.js';
import { parseResourcesEntry, RESOURCES_KEY_PREFIX, syncPlatformResources } from '../src/resources.js';

/**
 * A vertical's MCP endpoint, zero-config end to end (#1619).
 *
 * The path a real MCP client takes, and no step of it faked:
 *
 *   1. It registers ITSELF (RFC 7591, no administrator), as a public client whose callback
 *      is at its own vendor, which is where every real MCP client's callback is.
 *   2. It asks `/authorize` for a token for the vertical's endpoint (`resource`, RFC 8707).
 *      The platform registered that resource, so the answer is a login page, not
 *      `invalid_target`.
 *   3. The user signs in and consents, and the code redeems for an access token whose `aud`
 *      is that resource.
 *   4. The vertical's REAL MCP mount (`@substrat-run/vertical-host`), verifying with the
 *      REAL bearer verifier (`@substrat-run/vertical-auth/oidc`) against this issuer's JWKS,
 *      accepts it.
 *
 * Then each property's negative twin: a resource nobody registered is still refused, a
 * token for vertical B is refused by vertical A, an `id_token` is refused as a bearer, and
 * an un-registered (deleted) vertical's resource can no longer be minted or refreshed.
 *
 * The resource string is never written out by hand. It is `mcpResourceOf(origin)`, the
 * one computation the vertical's mount publishes and the dashboard registers, and the test
 * reads the vertical's own protected-resource document to show the two agree.
 */

const ORIGIN = 'http://localhost:8877';
const ADMIN = { email: 'admin@auth.test', password: 'admin-demo-pass', name: 'Demo Admin' };
const USER = { email: 'member@auth.test', password: 'member-demo-pass', name: 'A Member' };
/** An MCP client's callback lives at its own vendor, never at the vertical. */
const CLIENT_REDIRECT = 'https://mcp-client.example/oauth/callback';

const DESK_A = 'https://desk-a.example';
const DESK_B = 'https://desk-b.example';
const APP_A = scopeId.parse(ulid());
const APP_B = scopeId.parse(ulid());
const RESOURCE_A = mcpResourceOf(DESK_A);
const RESOURCE_B = mcpResourceOf(DESK_B);

let db: Database.Database;
let sql: SqlExec;
let auth: Auth;

function sqlExecOf(database: Database.Database): SqlExec {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = database.prepare(query);
      if (!stmt.reader) {
        stmt.run(...(bindings as []));
        return { columnNames: [], toArray: () => [], raw: () => [][Symbol.iterator]() };
      }
      const objects = stmt.all(...(bindings as [])) as Record<string, unknown>[];
      return {
        columnNames: stmt.columns().map((c) => c.name),
        toArray: () => objects,
        raw: () => (stmt.raw(true).all(...(bindings as [])) as unknown[][]).values(),
      };
    },
  };
}

const call = (path: string, init?: RequestInit): Promise<Response> =>
  auth.handler(new Request(`${ORIGIN}${path}`, init) as never);

/** What the platform delivers to this issuer's `/internal/configure` for one vertical. */
function register(app: string, identifiers: string[]) {
  return syncPlatformResources(sql, parseResourcesEntry(`${RESOURCES_KEY_PREFIX}${app}`, JSON.stringify(identifiers)), Date.now());
}

const resourceRows = () =>
  db.prepare('SELECT * FROM oauth_resource ORDER BY identifier').all() as Record<string, unknown>[];

beforeEach(async () => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  sql = sqlExecOf(db);
  auth = buildAuth({
    database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
    secret: 'test-secret-000000000000000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: new MockEmailTransport(),
    sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    allowSignup: true,
  });
  const admin = await auth.api.signUpEmail({ body: ADMIN });
  db.prepare("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?").run(admin.user.id);
  await auth.api.signUpEmail({ body: USER });
});

// ── the MCP client's half ────────────────────────────────────────────────────

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(digest) };
}

/** A public client, registered by itself — what Claude and every other MCP client does. */
async function registerMcpClient(): Promise<string> {
  const res = await call('/api/auth/oauth2/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Probe MCP Client',
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function authorizePath(clientId: string, challenge: string, resource: string): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    scope: 'openid profile offline_access',
    state: 'st',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource,
  });
  return `/api/auth/oauth2/authorize?${q.toString()}`;
}

const NAVIGATE = { 'sec-fetch-mode': 'navigate' } as const;
const FROM_FETCH = { 'content-type': 'application/json', 'sec-fetch-mode': 'cors' } as const;

/** Where `/authorize` sent the browser, and the refusal if it was one. */
async function authorize(clientId: string, challenge: string, resource: string) {
  const res = await call(authorizePath(clientId, challenge, resource), { headers: NAVIGATE });
  expect(res.status).toBe(302);
  const location = res.headers.get('location') ?? '';
  const error = location.startsWith(CLIENT_REDIRECT) ? new URL(location).searchParams : null;
  return { location, error: error?.get('error') ?? null, description: error?.get('error_description') ?? null };
}

/** Sign in from the login page, consent, and redeem: the whole browser round trip. */
async function tokensFor(clientId: string, resource: string) {
  const { verifier, challenge } = await pkce();
  const first = await authorize(clientId, challenge, resource);
  expect(first.error).toBeNull();
  expect(first.location.startsWith('/login?')).toBe(true);
  const oauthQuery = new URL(`http://x${first.location}`).search.replace(/^\?/, '');

  const signIn = await call('/api/auth/sign-in/email', {
    method: 'POST',
    headers: FROM_FETCH,
    body: JSON.stringify({ email: USER.email, password: USER.password, oauth_query: oauthQuery }),
  });
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .join('; ');
  const toConsent = (await signIn.json()) as { url: string };
  expect(toConsent.url.startsWith('/consent?')).toBe(true);

  const consent = await call('/api/auth/oauth2/consent', {
    method: 'POST',
    headers: { ...FROM_FETCH, cookie },
    body: JSON.stringify({ accept: true, oauth_query: new URL(`http://x${toConsent.url}`).search.replace(/^\?/, '') }),
  });
  expect(consent.status).toBe(200);
  const code = new URL(((await consent.json()) as { url: string }).url).searchParams.get('code') ?? '';
  expect(code).toBeTruthy();

  const token = await call('/api/auth/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CLIENT_REDIRECT,
      code_verifier: verifier,
      client_id: clientId,
      resource,
    }).toString(),
  });
  expect(token.status).toBe(200);
  return (await token.json()) as { access_token: string; id_token: string; refresh_token?: string };
}

// ── the vertical's half ──────────────────────────────────────────────────────

/**
 * A vertical as a hosted one is wired: `mountOperations` gives it its MCP endpoint, and its
 * resolver verifies a bearer against the issuer it was bound to, the way
 * `oidcRpAuthProvider`'s bearer fallback does. The issuer's keys come from its own JWKS.
 */
async function verticalAt(): Promise<Hono> {
  const jwks = (await (await call('/api/auth/jwks')).json()) as JSONWebKeySet;
  const verifier = oidcAuthProvider({ issuer: ORIGIN, keys: createLocalJWKSet(jwks) });
  const app = new Hono();
  mountOperations(
    app,
    { 'desk/whoami': { summary: 'Who is calling', http: { method: 'GET', path: '/me' } } } as const,
    async (c) => {
      const subject = await verifier.resolve(c.req.raw.headers);
      if (!subject) throw new HTTPException(401, { message: 'unauthenticated' });
      return { invoke: async () => ({ sub: subject.sub }) } as never;
    },
    { mcp: { protectedResource: { authorizationServers: [ORIGIN] } } },
  );
  return app;
}

async function callTool(vertical: Hono, origin: string, bearer: string) {
  const res = await vertical.request(`${origin}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'desk_whoami', arguments: {} } }),
  });
  return { status: res.status, challenge: res.headers.get('WWW-Authenticate'), body: res.status === 200 ? await res.json() : null };
}

// ── the tests ────────────────────────────────────────────────────────────────

describe('an MCP client reaches a vertical with nothing configured by hand (#1619)', () => {
  it('registers the exact resource the vertical advertises', async () => {
    const vertical = await verticalAt();
    const doc = (await (await vertical.request(`${DESK_A}/.well-known/oauth-protected-resource/api/mcp`)).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    // The string a client will ask for is the vertical's own, and it is the string the
    // platform registers — one function, not two spellings of one URL.
    expect(doc.resource).toBe(RESOURCE_A);
    expect(doc.authorization_servers).toEqual([ORIGIN]);
  });

  it('DCR → authorize with resource → login → token with aud → the vertical accepts it', async () => {
    register(APP_A, [RESOURCE_A]);
    const clientId = await registerMcpClient();
    const tokens = await tokensFor(clientId, RESOURCE_A);

    // A JWT, not an opaque string: the resource made it one, and its audience is the endpoint.
    // `openid` adds the issuer's userinfo endpoint beside it, which the vertical tolerates.
    const aud = decodeJwt(tokens.access_token).aud;
    expect(Array.isArray(aud) ? aud : [aud]).toContain(RESOURCE_A);

    const vertical = await verticalAt();
    const res = await callTool(vertical, DESK_A, tokens.access_token);
    expect(res.status).toBe(200);
    // The tool ran as the person who signed in, so the principal came from THIS token.
    const sub = decodeJwt(tokens.access_token).sub;
    expect(JSON.stringify(res.body)).toContain(String(sub));
  });

  it('needs no link between the client and the resource (per-client enforcement is off)', async () => {
    register(APP_A, [RESOURCE_A]);
    const clientId = await registerMcpClient();
    // The self-registered client was linked to nothing. With the plugin's default this is
    // `client … is not linked to resource(s) …` at /authorize.
    expect(db.prepare('SELECT COUNT(*) AS n FROM oauth_client_resource').get()).toEqual({ n: 0 });
    const { error, description } = await authorize(clientId, (await pkce()).challenge, RESOURCE_A);
    expect({ error, description }).toEqual({ error: null, description: null });
  });
});

describe('what stays refused', () => {
  it('a resource nobody registered is still invalid_target', async () => {
    register(APP_A, [RESOURCE_A]);
    const clientId = await registerMcpClient();
    const { error, description } = await authorize(clientId, (await pkce()).challenge, mcpResourceOf('https://nobody.example'));
    expect(error).toBe('invalid_target');
    expect(description).toContain('is not configured');
  });

  it("a token for vertical B's endpoint is refused by vertical A", async () => {
    register(APP_A, [RESOURCE_A]);
    register(APP_B, [RESOURCE_B]);
    const clientId = await registerMcpClient();
    const forB = await tokensFor(clientId, RESOURCE_B);
    const vertical = await verticalAt();

    const atA = await callTool(vertical, DESK_A, forB.access_token);
    expect(atA.status).toBe(401);
    expect(atA.challenge).toContain('error="invalid_token"');
    // The twin: the same token is accepted where it was meant to go.
    expect((await callTool(vertical, DESK_B, forB.access_token)).status).toBe(200);
  });

  it('an id_token presented as a bearer is refused — its audience is the client', async () => {
    register(APP_A, [RESOURCE_A]);
    const clientId = await registerMcpClient();
    const { id_token } = await tokensFor(clientId, RESOURCE_A);
    expect(decodeJwt(id_token).aud).toBe(clientId);
    const res = await callTool(await verticalAt(), DESK_A, id_token);
    expect(res.status).toBe(401);
    expect(res.challenge).toContain('error="invalid_token"');
  });

  it("an un-registered vertical's resource can no longer be minted, nor refreshed", async () => {
    register(APP_A, [RESOURCE_A]);
    const clientId = await registerMcpClient();
    const tokens = await tokensFor(clientId, RESOURCE_A);
    expect(tokens.refresh_token).toBeTruthy();

    // The dashboard's delete: the vertical's set becomes empty.
    expect(register(APP_A, [])).toEqual({ added: [], removed: [RESOURCE_A], operatorOwned: [] });

    const again = await authorize(clientId, (await pkce()).challenge, RESOURCE_A);
    expect(again.error).toBe('invalid_target');

    const refresh = await call('/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token ?? '',
        client_id: clientId,
      }).toString(),
    });
    expect(refresh.status).toBe(400);
    expect(((await refresh.json()) as { error?: string }).error).toBe('invalid_target');
  });
});

describe('the platform-owned registry', () => {
  it('is idempotent: delivering the same set twice leaves every row as it was', async () => {
    expect(register(APP_A, [RESOURCE_A]).added).toEqual([RESOURCE_A]);
    const once = resourceRows();
    expect(register(APP_A, [RESOURCE_A])).toEqual({ added: [], removed: [], operatorOwned: [] });
    expect(resourceRows()).toEqual(once);
  });

  it('holds the WHOLE set: a hostname that went away drops out, one that arrived is added', async () => {
    const custom = mcpResourceOf('https://crm.acme.example');
    register(APP_A, [RESOURCE_A, custom]);
    expect(register(APP_A, [RESOURCE_A])).toEqual({ added: [], removed: [custom], operatorOwned: [] });
    expect(resourceRows().map((r) => r['identifier'])).toEqual([RESOURCE_A]);
  });

  it("touches only its own vertical's rows", async () => {
    register(APP_A, [RESOURCE_A]);
    register(APP_B, [RESOURCE_B]);
    register(APP_A, []);
    expect(resourceRows().map((r) => r['identifier'])).toEqual([RESOURCE_B]);
  });

  it("never claims, changes or deletes an operator's row", async () => {
    const operator = mcpResourceOf('https://operator.example');
    db.prepare(
      "INSERT INTO oauth_resource (id, identifier, name, disabled) VALUES ('op', ?, 'Operator API', 1)",
    ).run(operator);
    expect(register(APP_A, [operator])).toEqual({ added: [], removed: [], operatorOwned: [operator] });
    register(APP_A, []);
    expect(resourceRows()).toEqual([expect.objectContaining({ identifier: operator, name: 'Operator API', disabled: 1, metadata: null })]);
  });

  it("takes over another vertical's stale claim on a hostname that now serves this one", async () => {
    register(APP_B, [RESOURCE_A]);
    expect(register(APP_A, [RESOURCE_A]).added).toEqual([RESOURCE_A]);
    // B's un-registration no longer reaches the row, because A owns it now.
    register(APP_B, []);
    expect(resourceRows().map((r) => r['identifier'])).toEqual([RESOURCE_A]);
  });

  it.each([
    ['not JSON', 'https://x.example/api/mcp'],
    ['not an array', '{"a":1}'],
    ['a relative URL', '["/api/mcp"]'],
    ['a fragment', '["https://x.example/api/mcp#frag"]'],
    ['credentials', '["https://u:p@x.example/api/mcp"]'],
    ['another scheme', '["javascript:alert(1)"]'],
  ])('refuses %s', (_label, value) => {
    expect(() => parseResourcesEntry(`${RESOURCES_KEY_PREFIX}${APP_A}`, value)).toThrow();
  });

  it('refuses a key whose suffix is not a scope id', () => {
    expect(() => parseResourcesEntry(`${RESOURCES_KEY_PREFIX}not-a-scope`, '[]')).toThrow();
  });

  it('reads "" as the empty set, which is the un-registration', () => {
    expect(parseResourcesEntry(`${RESOURCES_KEY_PREFIX}${APP_A}`, '')).toEqual({ appScopeId: APP_A, identifiers: [] });
  });
});

describe('what discovery says about resources', () => {
  it.each([
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration',
  ])('%s advertises resource_parameter_supported', async (path) => {
    const res = await call(path);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc['resource_parameter_supported']).toBe(true);
    // Everything else the plugin said is still there.
    expect(doc['issuer']).toBe(ORIGIN);
    expect(doc['authorization_endpoint']).toBeTruthy();
  });
});

describe('who may manage resources through the plugin', () => {
  /**
   * The plugin's resource endpoints are `SERVER_ONLY` — unreachable over HTTP — so the gate
   * is exercised the one way they can be reached: server code calling `auth.api` with a
   * caller's headers, which is what a console route forwarding a session would do.
   */
  async function sessionOf(who: { email: string; password: string }): Promise<Headers> {
    const res = await call('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(who),
    });
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0] ?? '')
      .join('; ');
    return new Headers({ cookie });
  }
  const create = (headers: Headers, identifier: string) =>
    auth.api.adminCreateOAuthResource({ headers, body: { identifier, name: identifier } });

  it('is not an HTTP surface at all', async () => {
    const res = await call('/api/auth/admin/oauth2/resources', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ identifier: 'https://over-http.example/api/mcp' }),
    });
    expect(res.status).toBe(404);
  });

  it('refuses a signed-in user who is not an administrator', async () => {
    await expect(create(await sessionOf(USER), 'https://user-made.example/api/mcp')).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(resourceRows()).toEqual([]);
  });

  it('lets an administrator, as for the client registry', async () => {
    await create(await sessionOf(ADMIN), 'https://admin-made.example/api/mcp');
    expect(resourceRows().map((r) => r['identifier'])).toEqual(['https://admin-made.example/api/mcp']);
  });
});

// ── a vertical's REST routes on a shared issuer (#1683) ──────────────────────

/**
 * The rest of the vertical, not only its MCP endpoint. #1619 made `/api/mcp` hold a token
 * to its own resource; every other route resolves the caller through the relying party's
 * bearer fallback, which verified the signature and the issuer and nothing else. On a team
 * auth-server that admitted every token the issuer ever signed for anyone.
 *
 * The verifier here is the one `oidcRpAuthProvider` builds when the dashboard has marked
 * the issuer shared: this app's client id, and `mcpResourceOf` for its resource. Every
 * token is a REAL one from this issuer, so the claims the rule reads — `aud`, `azp`,
 * `client_id`, and their absence on an `id_token` — are what Better Auth actually emits.
 */
describe("a vertical on a team auth-server accepts only its own bearers on REST (#1683)", () => {
  async function restAt(ownClientId: string): Promise<Hono> {
    const jwks = (await (await call('/api/auth/jwks')).json()) as JSONWebKeySet;
    const verifier = oidcAuthProvider({
      issuer: ORIGIN,
      keys: createLocalJWKSet(jwks),
      clientId: ownClientId,
      resourceOf: (origin) => mcpResourceOf(origin),
    });
    const app = new Hono();
    // One route handed the request URL, one handed headers alone: every caller written
    // before #1683 is the second, and the `Host` header is what names the origin there.
    app.get('/api/me', async (c) => {
      const subject = await verifier.resolve(c.req.raw.headers, c.req.url);
      return subject ? c.json({ sub: subject.sub }) : c.json({ error: 'unauthenticated' }, 401);
    });
    app.get('/api/me-by-host', async (c) => {
      const subject = await verifier.resolve(c.req.raw.headers);
      return subject ? c.json({ sub: subject.sub }) : c.json({ error: 'unauthenticated' }, 401);
    });
    return app;
  }

  const get = (app: Hono, url: string, bearer: string, host?: string) =>
    app.request(url, { headers: { authorization: `Bearer ${bearer}`, ...(host ? { host } : {}) } });

  it("admits A's own id_token and A's own client's access token", async () => {
    register(APP_A, [RESOURCE_A]);
    const clientA = await registerMcpClient();
    const own = await tokensFor(clientA, RESOURCE_A);
    // The shape the rule relies on: an id_token names the client in `aud` and carries no `azp`.
    expect(decodeJwt(own.id_token).aud).toBe(clientA);
    expect(decodeJwt(own.id_token).azp).toBeUndefined();
    const rest = await restAt(clientA);
    expect((await get(rest, `${DESK_A}/api/me`, own.id_token)).status).toBe(200);
    expect((await get(rest, `${DESK_A}/api/me`, own.access_token)).status).toBe(200);
  });

  it("admits an MCP client's access token for A's own resource, by URL and by Host", async () => {
    register(APP_A, [RESOURCE_A]);
    const clientA = await registerMcpClient();
    const mcpClient = await registerMcpClient();
    const { access_token } = await tokensFor(mcpClient, RESOURCE_A);
    // Its authorized party is the MCP client, never A — so only the resource admits it.
    expect(decodeJwt(access_token).azp).toBe(mcpClient);
    const rest = await restAt(clientA);
    expect((await get(rest, `${DESK_A}/api/me`, access_token)).status).toBe(200);
    expect((await get(rest, `${DESK_A}/api/me-by-host`, access_token, 'desk-a.example')).status).toBe(200);
    // No URL and no Host: nothing names our resource, so it is refused rather than guessed.
    expect((await get(rest, `${DESK_A}/api/me-by-host`, access_token)).status).toBe(401);
  });

  it("refuses another client's id_token — the replay #1683 describes", async () => {
    register(APP_A, [RESOURCE_A]);
    const clientA = await registerMcpClient();
    // Any client at all: DCR is open, so this is what an anonymous registrant holds.
    const other = await registerMcpClient();
    const { id_token } = await tokensFor(other, RESOURCE_A);
    const rest = await restAt(clientA);
    expect((await get(rest, `${DESK_A}/api/me`, id_token)).status).toBe(401);
    // The twin: at the app that IS that client, the same token is admitted.
    expect((await get(await restAt(other), `${DESK_A}/api/me`, id_token)).status).toBe(200);
  });

  it("refuses an MCP token minted for vertical B's endpoint, by URL and by Host", async () => {
    register(APP_A, [RESOURCE_A]);
    register(APP_B, [RESOURCE_B]);
    const clientA = await registerMcpClient();
    const mcpClient = await registerMcpClient();
    const forB = await tokensFor(mcpClient, RESOURCE_B);
    const rest = await restAt(clientA);
    expect((await get(rest, `${DESK_A}/api/me`, forB.access_token)).status).toBe(401);
    expect((await get(rest, `${DESK_A}/api/me-by-host`, forB.access_token, 'desk-a.example')).status).toBe(401);
    // The twin: at B's own origin it is B's resource, and admitted.
    expect((await get(rest, `${DESK_B}/api/me`, forB.access_token)).status).toBe(200);
  });
});
