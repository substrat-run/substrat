/**
 * `/internal/reconcile` on the real worker and the real `AuthServerDO`, in workerd (#1660).
 *
 * auth-server is LISTED, so its installs are other tenants' scopes, and since #1653 the
 * platform reconciles every one of them after each promote — the reconcile follows the
 * version a scope RUNS, and a listed vertical's promote changes that for all of them at
 * once. Until this route existed the catch-all answered 501, the sweep counted every install
 * `unsupported`, wrote no receipt, and asked the same installs again on every pass.
 *
 * The route's claim is that a reconcile is harmless on a live install — in particular that it
 * does not blank the `{slug, name}` a provision recorded, because a reconcile's body carries
 * neither (vertical-host's `reconcileBody`). So the first test compares the WHOLE of the
 * issuer's SQLite, table by table and row by row, after one provision and after a second
 * provision plus two reconciles (the drain's retry, then the sweep on two promotes).
 */
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';

const t = tenantId.parse(ulid());
const owner = ulid();

function platform(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`https://auth-server.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-substrat-platform': env.PLATFORM_SECRET, ...headers },
    body: JSON.stringify(body),
  });
}

const stubOf = (scope: string) => env.AUTH.get(env.AUTH.idFromName(scope));

/** Every row of every table in one issuer's SQLite, order-free. */
function dumpOf(scope: string): Promise<Record<string, string[]>> {
  return runInDurableObject(stubOf(scope), async (_instance, state) => {
    const names = [
      ...state.storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
      ),
    ].map((r) => String(r.name));
    const out: Record<string, string[]> = {};
    for (const name of names) {
      out[name] = [...state.storage.sql.exec(`SELECT * FROM "${name}"`)].map((r) => JSON.stringify(r)).sort();
    }
    return out;
  });
}

/** What `provisionInstance` recorded for a scope, read off the issuer's own `config` table. */
function recordedInstance(scope: string): Promise<unknown> {
  return runInDurableObject(stubOf(scope), async (_instance, state) => {
    const row = [...state.storage.sql.exec("SELECT value FROM config WHERE key = 'instance'")][0] as
      | { value: string }
      | undefined;
    return row ? JSON.parse(row.value) : null;
  });
}

const install = (scope: string) => ({
  tenantId: t,
  scopeId: scope,
  owner,
  slug: 'acme-auth',
  name: 'Acme Auth',
  // Delivered WITH provisioning, so the first provision seeds an administrator and the dump
  // has users and accounts in it — a comparison over an empty user table proves little.
  config: { ADMIN_EMAIL: 'root@acme.test', ADMIN_PASSWORD: 'correct-horse-battery' },
});

describe('auth-server /internal/reconcile is harmless on a live install (#1660)', () => {
  it('a second provision and two reconciles leave every row exactly as one provision did', async () => {
    const scope = scopeId.parse(ulid());
    expect((await platform('/internal/provision', install(scope))).status).toBe(201);
    const once = await dumpOf(scope);

    // The drain's retry, then the sweep reaching the install on two promotes. A reconcile
    // carries a tenant and a scope, and whatever else the platform gathered — never a slug,
    // a name or config.
    expect((await platform('/internal/provision', install(scope))).status).toBe(201);
    for (let i = 0; i < 2; i++) {
      const res = await platform('/internal/reconcile', {
        tenantId: t,
        scopeId: scope,
        entitlements: [],
        identityLinks: [],
        connectionGrants: [],
        connectionKeys: [],
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ tenantId: t, scopeId: scope });
    }
    const again = await dumpOf(scope);

    // The comparison is only worth something if the first provision wrote things: the
    // instance record, the delivered config, the seeded administrator, the console client.
    expect(once['config']!.some((r) => r.includes('"instance"'))).toBe(true);
    expect(once['config']!.some((r) => r.includes('cfg:ADMIN_EMAIL'))).toBe(true);
    expect(once['user']).toHaveLength(1);
    expect(Object.values(once).filter((rows) => rows.length > 0).length).toBeGreaterThan(3);

    expect(again).toEqual(once);
  });

  it('a reconcile does not blank the instance name or slug', async () => {
    const scope = scopeId.parse(ulid());
    await platform('/internal/provision', install(scope));
    const recorded = { tenantId: t, scopeId: scope, slug: 'acme-auth', name: 'Acme Auth' };
    expect(await recordedInstance(scope)).toEqual(recorded);

    expect((await platform('/internal/reconcile', { tenantId: t, scopeId: scope })).status).toBe(200);

    expect(await recordedInstance(scope)).toEqual(recorded);
  });
});

describe('auth-server /internal/reconcile refuses what it cannot vouch for (#1660)', () => {
  it('answers 409 for a scope that was never provisioned, and provisions nothing by asking', async () => {
    const scope = scopeId.parse(ulid());
    const res = await platform('/internal/reconcile', { tenantId: t, scopeId: scope });
    // A 2xx would write a receipt for a provision that never happened.
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('no instance of record');
    expect(await recordedInstance(scope)).toBeNull();
  });

  it('answers 409 when the recorded instance belongs to another tenant, and leaves it as it was', async () => {
    const scope = scopeId.parse(ulid());
    await platform('/internal/provision', install(scope));
    const before = await dumpOf(scope);

    const res = await platform('/internal/reconcile', { tenantId: tenantId.parse(ulid()), scopeId: scope });

    expect(res.status).toBe(409);
    expect(await dumpOf(scope)).toEqual(before);
  });

  it('refuses a caller without the platform secret, and a malformed body', async () => {
    const scope = scopeId.parse(ulid());
    await platform('/internal/provision', install(scope));
    expect((await platform('/internal/reconcile', { tenantId: t, scopeId: scope }, { 'x-substrat-platform': 'wrong' })).status).toBe(403);
    expect((await platform('/internal/reconcile', { scopeId: scope })).status).toBe(400);
    expect((await platform('/internal/reconcile', { tenantId: t, scopeId: 'not-a-ulid' })).status).toBe(400);
  });
});

describe('the rest of /internal/* is still an honest 501 (#1660)', () => {
  it.each(['/internal/snapshot', '/internal/restore', '/internal/rewind'])('POST %s', async (path) => {
    const res = await platform(path, {});
    expect(res.status).toBe(501);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(((await res.json()) as { error: string }).error).toContain('auth-server does not implement');
  });
});

/**
 * The platform's registration of a vertical's MCP endpoint (#1619), on the real worker and
 * the real `AuthServerDO`: `/internal/configure` carrying `substrat:resources:<scope>`
 * becomes rows in the DO's own `oauth_resource`, and the plugin reads them to decide
 * whether `/authorize` may mint for a `resource`.
 *
 * In workerd because node SQLite is not DO SQLite. The rows are written by raw SQL and read
 * back by drizzle's DO driver inside Better Auth, so the claim that the two agree about
 * types — timestamps, booleans, the metadata text — is only worth something here.
 */
describe('auth-server registers the MCP resources the platform delivers (#1619)', () => {
  const app = scopeId.parse(ulid());
  const key = `substrat:resources:${app}`;
  const resource = 'https://desk.acme.test/api/mcp';
  const redirect = 'https://mcp-client.test/callback';

  const configure = (scope: string, entries: { key: string; value: string }[]) =>
    platform('/internal/configure', { scopeId: scope, entries });

  /** Straight at the issuer DO, as the router would deliver it. */
  const issuer = (scope: string, path: string, init?: RequestInit) =>
    stubOf(scope).fetch(`https://auth-server.test${path}`, init);

  async function mcpClient(scope: string): Promise<string> {
    const res = await issuer(scope, '/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Probe MCP Client',
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { client_id: string }).client_id;
  }

  /** Where `/authorize` sends a signed-out browser asking for `resource`. */
  async function authorizeFor(scope: string, clientId: string, target: string): Promise<string> {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirect,
      scope: 'openid',
      state: 'st',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      resource: target,
    });
    // `manual`: a stub's fetch otherwise FOLLOWS the 302, and the DO has no /login to land on.
    const res = await issuer(scope, `/api/auth/oauth2/authorize?${q}`, {
      headers: { 'sec-fetch-mode': 'navigate' },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    return res.headers.get('location') ?? '';
  }

  it('turns the delivery into a row the plugin mints for, and un-registers it on ""', async () => {
    const scope = scopeId.parse(ulid());
    expect((await platform('/internal/provision', install(scope))).status).toBe(201);
    const clientId = await mcpClient(scope);

    // Before: the resource is not configured, the failure the issue reported.
    expect(await authorizeFor(scope, clientId, resource)).toContain('error=invalid_target');

    expect((await configure(scope, [{ key, value: JSON.stringify([resource]) }])).status).toBe(200);
    const rows = (await dumpOf(scope))['oauth_resource']!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(resource);
    // The registry is the one source of truth: the entry is not ALSO kept as delivered config.
    expect((await dumpOf(scope))['config']!.some((r) => r.includes('substrat:resources'))).toBe(false);

    // A login page, not a refusal — and no link between client and resource was needed.
    const location = await authorizeFor(scope, clientId, resource);
    expect(location.startsWith('/login?')).toBe(true);

    expect((await configure(scope, [{ key, value: '' }])).status).toBe(200);
    expect((await dumpOf(scope))['oauth_resource']).toEqual([]);
    expect(await authorizeFor(scope, clientId, resource)).toContain('error=invalid_target');
  });

  it('is idempotent on DO SQLite: the same delivery twice leaves every table as once did', async () => {
    const scope = scopeId.parse(ulid());
    await platform('/internal/provision', install(scope));
    await configure(scope, [{ key, value: JSON.stringify([resource, 'https://crm.acme.test/api/mcp']) }]);
    const once = await dumpOf(scope);
    expect(once['oauth_resource']).toHaveLength(2);

    await configure(scope, [{ key, value: JSON.stringify([resource, 'https://crm.acme.test/api/mcp']) }]);

    expect(await dumpOf(scope)).toEqual(once);
  });

  /**
   * All-or-nothing on DO SQLite. Each `exec` commits on its own there unless it is wrapped,
   * so a failure halfway through un-registering a multi-host app would leave part of its
   * set removed, and a deleted app has no later reconcile to finish it. The failure is
   * injected with a trigger that aborts the SECOND delete, once the first has gone through.
   */
  it('un-registers a multi-host set all-or-nothing: a failure halfway removes nothing', async () => {
    const scope = scopeId.parse(ulid());
    await platform('/internal/provision', install(scope));
    await configure(scope, [{ key, value: JSON.stringify([resource, 'https://crm.acme.test/api/mcp']) }]);
    const before = await dumpOf(scope);
    expect(before['oauth_resource']).toHaveLength(2);

    await runInDurableObject(stubOf(scope), async (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TRIGGER fail_second_delete BEFORE DELETE ON oauth_resource
         WHEN (SELECT COUNT(*) FROM oauth_resource) < 2
         BEGIN SELECT RAISE(ABORT, 'injected: the second delete fails'); END`,
      );
    });
    const failed = await configure(scope, [{ key, value: '' }]);
    await runInDurableObject(stubOf(scope), async (_instance, state) => {
      state.storage.sql.exec('DROP TRIGGER fail_second_delete');
    });

    expect(failed.status).toBe(400);
    expect(await dumpOf(scope)).toEqual(before);

    // The twin: the same delivery with nothing failing removes the whole set.
    expect((await configure(scope, [{ key, value: '' }])).status).toBe(200);
    expect((await dumpOf(scope))['oauth_resource']).toEqual([]);
  });

  it('refuses a malformed delivery whole, writing none of it', async () => {
    const scope = scopeId.parse(ulid());
    await platform('/internal/provision', install(scope));
    const before = await dumpOf(scope);

    const res = await configure(scope, [
      { key: 'ALLOW_SIGNUP', value: 'true' },
      { key: `substrat:resources:${ulid()}`, value: JSON.stringify([resource]) },
      { key, value: '["/relative/api/mcp"]' },
    ]);

    expect(res.status).toBe(400);
    expect(await dumpOf(scope)).toEqual(before);
  });

  it('refuses a caller without the platform secret', async () => {
    const scope = scopeId.parse(ulid());
    await platform('/internal/provision', install(scope));
    const before = await dumpOf(scope);
    const res = await platform(
      '/internal/configure',
      { scopeId: scope, entries: [{ key, value: JSON.stringify([resource]) }] },
      { 'x-substrat-platform': 'wrong' },
    );
    expect(res.status).toBe(403);
    expect(await dumpOf(scope)).toEqual(before);
  });
});

/**
 * A login's PLACES (#1670, `src/places.ts`), on the real worker and the real `AuthServerDO`.
 *
 * Every claim the Decision makes is pinned here, each with its twin, and in workerd because
 * the index is DO SQLite and so is the issuer's own evidence of issuance (the consent and
 * token rows Better Auth writes through drizzle's DO driver, read back here by raw SQL).
 *
 * The world: one team auth-server; two apps signing in at it, each with the OIDC client the
 * platform registered for it; logins who really sign in to those clients (authorize, consent,
 * token), and one who never does.
 */
describe("a login's places at the identity pool (#1670)", () => {
  const RP_CALLBACK = 'https://desk.acme.test/api/auth/callback';

  /** One provisioned issuer with open sign-up, and the requests that reach it. */
  async function pool() {
    const scope = scopeId.parse(ulid());
    const res = await platform('/internal/provision', {
      ...install(scope),
      config: { ADMIN_EMAIL: 'root@acme.test', ADMIN_PASSWORD: 'correct-horse-battery', ALLOW_SIGNUP: 'true' },
    });
    expect(res.status).toBe(201);
    /** Through the WORKER, as the router delivers a request for this issuer's hostname. */
    const routed = (path: string, init: RequestInit = {}) =>
      SELF.fetch(`https://auth.acme.test${path}`, {
        ...init,
        redirect: 'manual',
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          'x-substrat-tenant': t,
          'x-substrat-scope': scope,
          'x-substrat-router': env.ROUTER_SECRET,
        },
      });
    return { scope, routed };
  }
  type Pool = Awaited<ReturnType<typeof pool>>;

  // workerd has `getSetCookie`; the workers-types this project compiles against do not name it.
  const cookiesFrom = (res: Response) =>
    (res.headers as unknown as { getSetCookie(): string[] })
      .getSetCookie()
      .map((c) => c.split(';')[0] ?? '')
      .filter((pair) => !pair.endsWith('='))
      .join('; ');

  async function signUp(p: Pool, email: string): Promise<{ sub: string; cookie: string }> {
    const res = await p.routed('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct-horse-battery', name: email }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string } };
    return { sub: body.user.id, cookie: cookiesFrom(res) };
  }

  /** A relying party registering itself, exactly as the dashboard does at install (open DCR). */
  async function client(p: Pool, name: string): Promise<{ clientId: string; clientSecret: string }> {
    const res = await p.routed('/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: name,
        redirect_uris: [RP_CALLBACK],
        token_endpoint_auth_method: 'client_secret_post',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string; client_secret: string };
    return { clientId: body.client_id, clientSecret: body.client_secret };
  }

  const b64url = (bytes: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  /** The whole round trip a vertical's login takes: authorize, consent, code for tokens. */
  async function signInTo(p: Pool, who: { cookie: string }, rp: { clientId: string; clientSecret: string }) {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: rp.clientId,
      redirect_uri: RP_CALLBACK,
      scope: 'openid profile',
      state: 'st',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const authorize = await p.routed(`/api/auth/oauth2/authorize?${q}`, {
      headers: { 'sec-fetch-mode': 'navigate', cookie: who.cookie },
    });
    const location = authorize.headers.get('location') ?? '';
    expect(location.startsWith('/consent?')).toBe(true);
    const consent = await p.routed('/api/auth/oauth2/consent', {
      method: 'POST',
      // The consent screen is this issuer's own SPA, so the browser sends its origin — which
      // Better Auth requires of a cookie-bearing POST.
      headers: {
        'content-type': 'application/json',
        'sec-fetch-mode': 'cors',
        origin: 'https://auth.acme.test',
        cookie: who.cookie,
      },
      body: JSON.stringify({ accept: true, oauth_query: location.slice('/consent?'.length) }),
    });
    if (consent.status !== 200) throw new Error(`consent ${consent.status}: ${await consent.text()}`);
    const code = new URL(((await consent.json()) as { url: string }).url).searchParams.get('code') ?? '';
    const token = await p.routed('/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: RP_CALLBACK,
        code_verifier: verifier,
        client_id: rp.clientId,
        client_secret: rp.clientSecret,
      }).toString(),
    });
    expect(token.status).toBe(200);
  }

  /** The platform's registration of a team's apps, through `/internal/configure`. */
  const register = (p: Pool, team: string, apps: unknown[] | '') =>
    platform('/internal/configure', {
      scopeId: p.scope,
      entries: [{ key: `substrat:places:${team}`, value: apps === '' ? '' : JSON.stringify(apps) }],
    });

  const report = (p: Pool, body: Record<string, unknown>) =>
    p.routed('/api/places/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  async function placesOf(p: Pool, cookie: string | null, query = ''): Promise<{ status: number; body: unknown }> {
    const res = await p.routed(`/api/account/places${query}`, { headers: cookie ? { cookie } : {} });
    return { status: res.status, body: await res.json() };
  }

  /** Two apps of one team, each registered with its own client, plus people who use them. */
  async function world() {
    const p = await pool();
    const desk = await client(p, 'Desk');
    const crm = await client(p, 'CRM');
    const deskApp = scopeId.parse(ulid());
    const crmApp = scopeId.parse(ulid());
    expect(
      (
        await register(p, t, [
          { appScopeId: deskApp, clientId: desk.clientId, hostname: 'desk.acme.test', name: 'Acme Desk' },
          { appScopeId: crmApp, clientId: crm.clientId, hostname: 'crm.acme.test', name: 'Acme CRM' },
        ])
      ).status,
    ).toBe(200);
    const ann = await signUp(p, `ann-${ulid()}@acme.test`);
    const ben = await signUp(p, `ben-${ulid()}@acme.test`);
    await signInTo(p, ann, desk);
    await signInTo(p, ann, crm);
    await signInTo(p, ben, desk);
    const auth = (rp: { clientId: string; clientSecret: string }, scope: string) => ({
      client_id: rp.clientId,
      client_secret: rp.clientSecret,
      scope_id: scope,
    });
    return { p, desk, crm, deskApp, crmApp, ann, ben, as: { desk: auth(desk, deskApp), crm: auth(crm, crmApp) } };
  }

  const deskEntry = (app: string) => ({ tenantId: t, scopeId: app, hostname: 'desk.acme.test', name: 'Acme Desk' });
  const crmEntry = (app: string) => ({ tenantId: t, scopeId: app, hostname: 'crm.acme.test', name: 'Acme CRM' });

  it('lists exactly the entries a registered client reported for a login that signed in to it', async () => {
    const w = await world();
    expect((await report(w.p, { ...w.as.desk, op: 'present', sub: w.ann.sub })).status).toBe(204);
    expect((await report(w.p, { ...w.as.crm, op: 'present', sub: w.ann.sub })).status).toBe(204);

    const mine = await placesOf(w.p, w.ann.cookie);
    expect(mine.status).toBe(200);
    // Ordered by name, and EXACTLY the Decision's four keys per entry — nothing else about the
    // tenant, the client or the other members rides along.
    expect(mine.body).toEqual({ places: [crmEntry(w.crmApp), deskEntry(w.deskApp)] });
    for (const entry of (mine.body as { places: object[] }).places) {
      expect(Object.keys(entry).sort()).toEqual(['hostname', 'name', 'scopeId', 'tenantId']);
    }
  });

  it("drops an addition for a login the issuer never issued to that client for — and keeps it once it has", async () => {
    const w = await world();
    // Ben signed in to the desk, never to the CRM. The CRM's client naming him is exactly the
    // poisoning the report channel must not allow: answered like any other report, kept nowhere.
    expect((await report(w.p, { ...w.as.crm, op: 'present', sub: w.ben.sub })).status).toBe(204);
    expect((await placesOf(w.p, w.ben.cookie)).body).toEqual({ places: [] });

    // The twin: once Ben really signs in to the CRM, the same report is kept.
    await signInTo(w.p, w.ben, w.crm);
    expect((await report(w.p, { ...w.as.crm, op: 'present', sub: w.ben.sub })).status).toBe(204);
    expect((await placesOf(w.p, w.ben.cookie)).body).toEqual({ places: [crmEntry(w.crmApp)] });
  });

  it('refuses a client the platform never registered, however valid its credentials', async () => {
    const w = await world();
    // Open DCR: anybody can mint a client here. It authenticates fine and is still no place.
    const stranger = await client(w.p, 'Stranger');
    await signInTo(w.p, w.ann, stranger);
    const res = await report(w.p, {
      client_id: stranger.clientId,
      client_secret: stranger.clientSecret,
      scope_id: w.deskApp,
      op: 'present',
      sub: w.ann.sub,
    });
    expect(res.status).toBe(403);
    expect((await placesOf(w.p, w.ann.cookie)).body).toEqual({ places: [] });

    // Its twin: the registered desk client, same login, same scope, is kept.
    expect((await report(w.p, { ...w.as.desk, op: 'present', sub: w.ann.sub })).status).toBe(204);
    expect((await placesOf(w.p, w.ann.cookie)).body).toEqual({ places: [deskEntry(w.deskApp)] });
  });

  it('refuses wrong credentials for a registered client, and a registered client reporting for another scope', async () => {
    const w = await world();
    const wrong = await report(w.p, { ...w.as.desk, client_secret: 'not-the-secret', op: 'present', sub: w.ann.sub });
    expect(wrong.status).toBe(401);
    const elsewhere = await report(w.p, { ...w.as.desk, scope_id: w.crmApp, op: 'present', sub: w.ann.sub });
    expect(elsewhere.status).toBe(403);
    expect((await placesOf(w.p, w.ann.cookie)).body).toEqual({ places: [] });
  });

  it("cannot remove another app's entries: a client's removal reaches only its own rows", async () => {
    const w = await world();
    await report(w.p, { ...w.as.desk, op: 'present', sub: w.ann.sub });
    await report(w.p, { ...w.as.crm, op: 'present', sub: w.ann.sub });

    // The CRM says Ann is gone — from the CRM. The desk entry stands.
    expect((await report(w.p, { ...w.as.crm, op: 'absent', sub: w.ann.sub })).status).toBe(204);
    expect((await placesOf(w.p, w.ann.cookie)).body).toEqual({ places: [deskEntry(w.deskApp)] });
    // And a whole-set replace from the CRM naming nobody leaves the desk's rows alone too.
    expect((await report(w.p, { ...w.as.crm, op: 'replace', subs: [] })).status).toBe(204);
    expect((await placesOf(w.p, w.ann.cookie)).body).toEqual({ places: [deskEntry(w.deskApp)] });
  });

  it('removing or revoking a membership removes the entry', async () => {
    const w = await world();
    await report(w.p, { ...w.as.desk, op: 'present', sub: w.ann.sub });
    expect((await placesOf(w.p, w.ann.cookie)).body).toEqual({ places: [deskEntry(w.deskApp)] });
    expect((await report(w.p, { ...w.as.desk, op: 'absent', sub: w.ann.sub })).status).toBe(204);
    expect((await placesOf(w.p, w.ann.cookie)).body).toEqual({ places: [] });
  });

  it('a whole-set repair heals a lost addition AND a lost removal', async () => {
    const w = await world();
    // What the index believes: Ann is in the desk. What the vertical's directory says: Ann was
    // unbound (that `absent` was lost) and Ben joined (that `present` was lost).
    await report(w.p, { ...w.as.desk, op: 'present', sub: w.ann.sub });
    expect((await placesOf(w.p, w.ben.cookie)).body).toEqual({ places: [] });

    expect((await report(w.p, { ...w.as.desk, op: 'replace', subs: [w.ben.sub] })).status).toBe(204);

    expect((await placesOf(w.p, w.ann.cookie)).body).toEqual({ places: [] });
    expect((await placesOf(w.p, w.ben.cookie)).body).toEqual({ places: [deskEntry(w.deskApp)] });
    // A repair is held to the same evidence as an addition: naming a login that never signed
    // in to the CRM adds nobody.
    await report(w.p, { ...w.as.crm, op: 'replace', subs: [w.ben.sub, w.ann.sub] });
    expect((await placesOf(w.p, w.ben.cookie)).body).toEqual({ places: [deskEntry(w.deskApp)] });
    expect((await placesOf(w.p, w.ann.cookie)).body).toEqual({ places: [crmEntry(w.crmApp)] });
  });

  it('answers only for the session: a probe naming another sub learns nothing', async () => {
    const w = await world();
    await report(w.p, { ...w.as.desk, op: 'present', sub: w.ann.sub });

    // Ben, asking about Ann by every spelling a query string allows, gets his own (empty) list.
    const plain = await placesOf(w.p, w.ben.cookie);
    for (const probe of [`?sub=${w.ann.sub}`, `?userId=${w.ann.sub}`, `?tenantId=${t}`]) {
      expect(await placesOf(w.p, w.ben.cookie, probe)).toEqual(plain);
    }
    expect(plain.body).toEqual({ places: [] });

    // Signed out, the answer is one constant refusal whatever is asked.
    const signedOut = await placesOf(w.p, null);
    expect(signedOut.status).toBe(401);
    expect(await placesOf(w.p, null, `?sub=${w.ann.sub}`)).toEqual(signedOut);
    // And the positive twin: Ann herself sees the entry.
    expect((await placesOf(w.p, w.ann.cookie)).body).toEqual({ places: [deskEntry(w.deskApp)] });
  });

  it('gives another origin nothing to read: no CORS grant, and no cache may keep it', async () => {
    const w = await world();
    await report(w.p, { ...w.as.desk, op: 'present', sub: w.ann.sub });
    const res = await w.p.routed('/api/account/places', {
      headers: { cookie: w.ann.cookie, origin: 'https://desk.acme.test' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it("the platform's registration decides the entry, and clearing it empties every list", async () => {
    const w = await world();
    await report(w.p, { ...w.as.desk, op: 'present', sub: w.ann.sub });
    await report(w.p, { ...w.as.desk, op: 'present', sub: w.ben.sub });

    // A rename or new hostname is the platform's to say, and every entry follows it.
    await register(w.p, t, [
      { appScopeId: w.deskApp, clientId: w.desk.clientId, hostname: 'help.acme.test', name: 'Acme Help' },
      { appScopeId: w.crmApp, clientId: w.crm.clientId, hostname: 'crm.acme.test', name: 'Acme CRM' },
    ]);
    expect((await placesOf(w.p, w.ann.cookie)).body).toEqual({
      places: [{ tenantId: t, scopeId: w.deskApp, hostname: 'help.acme.test', name: 'Acme Help' }],
    });

    // The team deletes the desk (it drops out of the next delivery): gone from every list.
    await register(w.p, t, [{ appScopeId: w.crmApp, clientId: w.crm.clientId, hostname: 'crm.acme.test', name: 'Acme CRM' }]);
    expect((await placesOf(w.p, w.ann.cookie)).body).toEqual({ places: [] });
    expect((await placesOf(w.p, w.ben.cookie)).body).toEqual({ places: [] });
    // And the desk's client is no longer a place at all.
    expect((await report(w.p, { ...w.as.desk, op: 'present', sub: w.ann.sub })).status).toBe(403);
  });

  it('an app dropped and registered again starts empty: its old entries do not come back', async () => {
    const w = await world();
    await report(w.p, { ...w.as.desk, op: 'present', sub: w.ann.sub });
    // Moved to another issuer and back (an Identity change, undone), under a fresh client as a
    // re-install registers one. The entries were admitted on evidence for the OLD client, so
    // they must not resurface under the new one without being earned again.
    await register(w.p, t, [{ appScopeId: w.crmApp, clientId: w.crm.clientId, hostname: 'crm.acme.test', name: 'Acme CRM' }]);
    const again = await client(w.p, 'Desk, re-registered');
    await register(w.p, t, [
      { appScopeId: w.deskApp, clientId: again.clientId, hostname: 'desk.acme.test', name: 'Acme Desk' },
      { appScopeId: w.crmApp, clientId: w.crm.clientId, hostname: 'crm.acme.test', name: 'Acme CRM' },
    ]);
    expect((await placesOf(w.p, w.ann.cookie)).body).toEqual({ places: [] });
    // The twin: the same holds for a client change in place, with no drop in between.
    await signInTo(w.p, w.ann, again);
    await report(w.p, { client_id: again.clientId, client_secret: again.clientSecret, scope_id: w.deskApp, op: 'present', sub: w.ann.sub });
    expect((await placesOf(w.p, w.ann.cookie)).body).toEqual({ places: [deskEntry(w.deskApp)] });
    await register(w.p, t, [
      { appScopeId: w.deskApp, clientId: w.desk.clientId, hostname: 'desk.acme.test', name: 'Acme Desk' },
      { appScopeId: w.crmApp, clientId: w.crm.clientId, hostname: 'crm.acme.test', name: 'Acme CRM' },
    ]);
    expect((await placesOf(w.p, w.ann.cookie)).body).toEqual({ places: [] });
  });

  it("one team's delivery never touches another team's registrations", async () => {
    const w = await world();
    await report(w.p, { ...w.as.desk, op: 'present', sub: w.ann.sub });
    const otherTeam = tenantId.parse(ulid());
    expect((await register(w.p, otherTeam, '')).status).toBe(200);
    expect((await placesOf(w.p, w.ann.cookie)).body).toEqual({ places: [deskEntry(w.deskApp)] });
    expect((await register(w.p, t, '')).status).toBe(200);
    expect((await placesOf(w.p, w.ann.cookie)).body).toEqual({ places: [] });
  });

  it('refuses a malformed registration whole, and a caller without the platform secret', async () => {
    const w = await world();
    const before = await dumpOf(w.p.scope);
    const malformed = await register(w.p, t, [
      { appScopeId: w.deskApp, clientId: w.desk.clientId, hostname: 'https://desk.acme.test', name: 'Acme Desk' },
    ]);
    expect(malformed.status).toBe(400);
    const unsigned = await platform(
      '/internal/configure',
      { scopeId: w.p.scope, entries: [{ key: `substrat:places:${t}`, value: '' }] },
      { 'x-substrat-platform': 'wrong' },
    );
    expect(unsigned.status).toBe(403);
    expect(await dumpOf(w.p.scope)).toEqual(before);
  });

  it('says where to report, so a vertical reports only to an issuer that keeps an index', async () => {
    const { routed } = await pool();
    const res = await routed('/.well-known/substrat-places');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ report_endpoint: 'https://auth.acme.test/api/places/report' });
  });
});

/**
 * A preview's own client (#1704), on the real worker and the real `AuthServerDO`: the check,
 * the mint through the plugin's own registration, and the tag-scoped delete, all against DO
 * SQLite — where `json_each`, `AUTOINCREMENT` and the explicit dependent-row delete have to
 * hold, and where node's better-sqlite3 proves nothing about them.
 */
describe('auth-server mints and retires a preview’s own client (#1704)', () => {
  const parentHost = 'desk.acme.test';
  const parentCallback = `https://${parentHost}/api/auth/callback`;

  const previewCall = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    SELF.fetch(`https://auth-server.test${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-substrat-platform': env.PLATFORM_SECRET, ...headers },
      body: JSON.stringify(body),
    });

  /** One provisioned issuer holding prod's client for the parent, bound by the platform (#1670). */
  async function issuerWithParent(tenant = t) {
    const scope = scopeId.parse(ulid());
    expect((await platform('/internal/provision', { ...install(scope), tenantId: tenant })).status).toBe(201);
    const reg = await stubOf(scope).fetch('https://auth-server.test/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Acme Desk',
        redirect_uris: [parentCallback],
        token_endpoint_auth_method: 'client_secret_post',
      }),
    });
    expect(reg.status).toBe(201);
    const prod = ((await reg.json()) as { client_id: string }).client_id;
    const parent = scopeId.parse(ulid());
    const bound = await platform('/internal/configure', {
      scopeId: scope,
      entries: [
        {
          key: `substrat:places:${tenant}`,
          value: JSON.stringify([{ appScopeId: parent, clientId: prod, hostname: parentHost, name: 'Acme Desk' }]),
        },
      ],
    });
    expect(bound.status).toBe(200);
    return { scope, prod, parent, tenant };
  }

  const mintBody = (w: { scope: string; parent: string; tenant: string }, preview: string, tag = 'pr-7') => ({
    tenantId: w.tenant,
    scopeId: w.scope,
    parentScopeId: w.parent,
    parentRedirectUris: [parentCallback],
    previewScopeId: preview,
    redirectUri: `https://desk--${tag}.acme.test/api/auth/callback`,
    postLogoutRedirectUri: `https://desk--${tag}.acme.test/`,
    clientName: `Acme Desk (${tag})`,
  });

  const clientRow = (scope: string, clientId: string) =>
    runInDurableObject(stubOf(scope), async (_i, state) => {
      const row = [...state.storage.sql.exec('SELECT * FROM oauth_client WHERE client_id = ?', clientId)][0];
      return row ? JSON.stringify(row) : null;
    });

  it('claims the platform-bound parent, mints exactly the preview’s URIs, and leaves prod’s client as it was', async () => {
    const w = await issuerWithParent();
    const prodBefore = await clientRow(w.scope, w.prod);
    const check = await previewCall('POST', '/internal/preview-client/check', {
      tenantId: t,
      scopeId: w.scope,
      parentScopeId: w.parent,
      parentRedirectUris: [parentCallback],
    });
    expect(check.status).toBe(200);
    expect(await check.json()).toEqual({ claimed: true });

    const preview = scopeId.parse(ulid());
    const res = await previewCall('POST', '/internal/preview-client', mintBody(w, preview));
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { clientId: string; clientSecret: string; generation: number };
    const row = JSON.parse((await clientRow(w.scope, minted.clientId))!) as Record<string, unknown>;
    expect(JSON.parse(String(row.redirect_uris))).toEqual(['https://desk--pr-7.acme.test/api/auth/callback']);
    expect(JSON.parse(String(row.post_logout_redirect_uris))).toEqual(['https://desk--pr-7.acme.test/']);
    expect(await clientRow(w.scope, w.prod)).toBe(prodBefore);
  });

  it('a callback match alone is no claim on DO SQLite either — the binding is what counts', async () => {
    const w = await issuerWithParent();
    const res = await previewCall('POST', '/internal/preview-client/check', {
      tenantId: t,
      scopeId: w.scope,
      parentScopeId: scopeId.parse(ulid()), // an app the platform never bound here
      parentRedirectUris: [parentCallback],
    });
    expect(await res.json()).toEqual({ claimed: false });
    const mint = await previewCall('POST', '/internal/preview-client', { ...mintBody(w, scopeId.parse(ulid())), parentScopeId: scopeId.parse(ulid()) });
    expect(mint.status).toBe(409);
  });

  it("refuses another tenant's call, even when that issuer holds a matching binding and client", async () => {
    const b = await issuerWithParent(tenantId.parse(ulid()));
    const before = await dumpOf(b.scope);
    // Tenant t's preview, aimed at tenant B's issuer: the platform secret is valid, the parent
    // binding and callback match — and the issuer still refuses, because it is not t's.
    for (const [method, path, body] of [
      ['POST', '/internal/preview-client/check', { tenantId: t, scopeId: b.scope, parentScopeId: b.parent, parentRedirectUris: [parentCallback] }],
      ['POST', '/internal/preview-client', { ...mintBody(b, scopeId.parse(ulid())), tenantId: t }],
      ['DELETE', '/internal/preview-client', { tenantId: t, scopeId: b.scope, previewScopeId: scopeId.parse(ulid()) }],
    ] as const) {
      const res = await previewCall(method, path, body);
      expect(res.status).toBe(403);
    }
    expect(await dumpOf(b.scope)).toEqual(before);
  });

  it('retires by tag and generation: older ones go, prod’s never, and the reap takes the rest', async () => {
    const w = await issuerWithParent();
    const preview = scopeId.parse(ulid());
    const mint = async () =>
      (await (await previewCall('POST', '/internal/preview-client', mintBody(w, preview))).json()) as {
        clientId: string;
        generation: number;
      };
    const a = await mint();
    const b = await mint();
    expect(b.generation).toBeGreaterThan(a.generation);
    const keep = await previewCall('DELETE', '/internal/preview-client', { tenantId: t, scopeId: w.scope, previewScopeId: preview, keep: a.clientId });
    expect(await keep.json()).toEqual({ deleted: [], kept: true, superseded: true });
    const keepNewest = await previewCall('DELETE', '/internal/preview-client', { tenantId: t, scopeId: w.scope, previewScopeId: preview, keep: b.clientId });
    expect(await keepNewest.json()).toEqual({ deleted: [a.clientId], kept: true, superseded: false });
    expect(await clientRow(w.scope, a.clientId)).toBeNull();

    // A delete for EVERY preview id there is — and prod's untagged client is still there.
    const prodBefore = await clientRow(w.scope, w.prod);
    for (const id of [preview, w.parent, w.scope]) {
      await previewCall('DELETE', '/internal/preview-client', { tenantId: t, scopeId: w.scope, previewScopeId: id });
      await previewCall('DELETE', '/internal/preview-client', { tenantId: t, scopeId: w.scope, previewScopeId: id, only: w.prod });
    }
    expect(await clientRow(w.scope, w.prod)).toBe(prodBefore);
    expect(await clientRow(w.scope, b.clientId)).toBeNull();
  });
});

/** The same pin on workerd's own URL implementation (#1704): brackets kept, loopback refused. */
describe('preview-client redirect URIs on workerd (#1704)', () => {
  it('an IPv6 loopback hostname keeps its brackets here too, and no loopback redirect is minted', async () => {
    expect(new URL('http://[::1]:8080/cb').hostname).toBe('[::1]');
    const scope = scopeId.parse(ulid());
    for (const redirectUri of ['http://[::1]/api/auth/callback', 'http://localhost/api/auth/callback', 'http://127.0.0.1/api/auth/callback']) {
      const res = await SELF.fetch('https://auth-server.test/internal/preview-client', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-substrat-platform': env.PLATFORM_SECRET },
        body: JSON.stringify({
          tenantId: t,
          scopeId: scope,
          parentScopeId: scopeId.parse(ulid()),
          parentRedirectUris: ['https://desk.acme.test/api/auth/callback'],
          previewScopeId: scopeId.parse(ulid()),
          redirectUri,
          postLogoutRedirectUri: 'https://desk--pr-7.acme.test/',
          clientName: 'Desk (pr-7)',
        }),
      });
      expect(res.status).toBe(400);
    }
  });
});

/**
 * RFC 8693 token exchange (#1824, `src/token-exchange.ts`), on the real worker and the real
 * `AuthServerDO`: a host app's user, signed in for real, is acted for by another app of the
 * same team at the host's MCP endpoint — and not once the platform revokes the grant.
 *
 * In workerd because every piece that matters is the runtime's: the worker splitting the one
 * token endpoint between the plugin and the exchange (and passing every other grant through
 * with its body unread), the plugin's own client authentication, the JWKS its `jwt` plugin
 * signs with, and the three platform registries on DO SQLite.
 */
describe('token exchange: one app acting for another app’s user (#1824)', () => {
  const RP_CALLBACK = 'https://desk.acme.test/api/auth/callback';
  const EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
  const DESK_MCP = 'https://desk.acme.test/api/mcp';

  async function world() {
    const scope = scopeId.parse(ulid());
    expect(
      (
        await platform('/internal/provision', {
          ...install(scope),
          config: { ADMIN_EMAIL: 'root@acme.test', ADMIN_PASSWORD: 'correct-horse-battery', ALLOW_SIGNUP: 'true' },
        })
      ).status,
    ).toBe(201);
    const routed = (path: string, init: RequestInit = {}) =>
      SELF.fetch(`https://auth.acme.test${path}`, {
        ...init,
        redirect: 'manual',
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          'x-substrat-tenant': t,
          'x-substrat-scope': scope,
          'x-substrat-router': env.ROUTER_SECRET,
        },
      });
    const client = async (name: string) => {
      const res = await routed('/api/auth/oauth2/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: name, redirect_uris: [RP_CALLBACK], token_endpoint_auth_method: 'client_secret_post' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { client_id: string; client_secret: string };
      return { id: body.client_id, secret: body.client_secret };
    };
    const desk = await client('Desk');
    const help = await client('Help');
    const deskApp = scopeId.parse(ulid());
    const helpApp = scopeId.parse(ulid());
    const delegations = (value: unknown) =>
      platform('/internal/configure', {
        scopeId: scope,
        entries: [{ key: `substrat:delegations:${deskApp}`, value: value === '' ? '' : JSON.stringify(value) }],
      });
    expect(
      (
        await platform('/internal/configure', {
          scopeId: scope,
          entries: [
            { key: `substrat:resources:${deskApp}`, value: JSON.stringify([DESK_MCP]) },
            {
              key: `substrat:places:${t}`,
              value: JSON.stringify([
                { appScopeId: deskApp, clientId: desk.id, hostname: 'desk.acme.test', name: 'Acme Desk' },
                { appScopeId: helpApp, clientId: help.id, hostname: 'help.acme.test', name: 'Acme Help' },
              ]),
            },
            {
              key: `substrat:delegations:${deskApp}`,
              value: JSON.stringify([{ actor: helpApp, permissions: ['tickets.read', 'tickets.comment'] }]),
            },
          ],
        })
      ).status,
    ).toBe(200);
    return { scope, routed, desk, help, deskApp, helpApp, delegations };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const b64url = (bytes: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  /** A user signing up, then signing in to the desk for real: authorize, consent, code for tokens. */
  async function signedInToDesk(w: World): Promise<{ sub: string; idToken: string }> {
    const up = await w.routed('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `ann-${ulid()}@acme.test`, password: 'correct-horse-battery', name: 'Ann' }),
    });
    expect(up.status).toBe(200);
    const sub = ((await up.json()) as { user: { id: string } }).user.id;
    const cookie = (up.headers as unknown as { getSetCookie(): string[] })
      .getSetCookie()
      .map((c) => c.split(';')[0] ?? '')
      .filter((pair) => !pair.endsWith('='))
      .join('; ');
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: w.desk.id,
      redirect_uri: RP_CALLBACK,
      scope: 'openid profile',
      state: 'st',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const authorize = await w.routed(`/api/auth/oauth2/authorize?${q}`, { headers: { 'sec-fetch-mode': 'navigate', cookie } });
    const location = authorize.headers.get('location') ?? '';
    expect(location.startsWith('/consent?')).toBe(true);
    const consent = await w.routed('/api/auth/oauth2/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-mode': 'cors', origin: 'https://auth.acme.test', cookie },
      body: JSON.stringify({ accept: true, oauth_query: location.slice('/consent?'.length) }),
    });
    expect(consent.status).toBe(200);
    const code = new URL(((await consent.json()) as { url: string }).url).searchParams.get('code') ?? '';
    // Through the same route the exchange is split off from: an ordinary grant still reaches the plugin.
    const token = await w.routed('/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: RP_CALLBACK,
        code_verifier: verifier,
        client_id: w.desk.id,
        client_secret: w.desk.secret,
      }).toString(),
    });
    expect(token.status).toBe(200);
    return { sub, idToken: ((await token.json()) as { id_token: string }).id_token };
  }

  const exchange = (w: World, client: { id: string; secret: string }, params: Record<string, string>) =>
    w.routed('/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: EXCHANGE, client_id: client.id, client_secret: client.secret, ...params }).toString(),
    });

  const stageA = (w: World, idToken: string) =>
    exchange(w, w.desk, {
      subject_token: idToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      audience: w.help.id,
    });

  const stageB = (w: World, assertion: string) =>
    exchange(w, w.help, {
      subject_token: assertion,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      resource: DESK_MCP,
      scope: 'tickets.read',
    });

  it('mints an assertion for the actor, then a token for the host’s MCP endpoint, both verifiable at the JWKS', async () => {
    const w = await world();
    const ann = await signedInToDesk(w);

    const a = await stageA(w, ann.idToken);
    expect(a.status).toBe(200);
    expect(a.headers.get('cache-control')).toBe('no-store');
    const assertion = (await a.json()) as Record<string, unknown>;
    expect(assertion).toMatchObject({ issued_token_type: 'urn:ietf:params:oauth:token-type:jwt', token_type: 'N_A', expires_in: 300 });

    const b = await stageB(w, assertion['access_token'] as string);
    expect(b.status).toBe(200);
    const access = (await b.json()) as Record<string, unknown>;
    expect(access).toMatchObject({
      issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      token_type: 'Bearer',
      scope: 'tickets.read',
    });
    expect(access).not.toHaveProperty('refresh_token');

    // Verified the way the host's MCP endpoint verifies a bearer: the published JWKS, this
    // issuer, and its own resource as the audience.
    const jwks = (await (await w.routed('/api/auth/jwks')).json()) as JSONWebKeySet;
    const { payload } = await jwtVerify(access['access_token'] as string, createLocalJWKSet(jwks), {
      issuer: 'https://auth.acme.test',
      audience: DESK_MCP,
    });
    expect(payload).toMatchObject({
      sub: ann.sub,
      azp: w.help.id,
      client_id: w.help.id,
      scope: 'tickets.read',
      act: { iss: 'https://auth.acme.test', sub: w.help.id },
      substrat_delegation: { stage: 'access', host: w.deskApp, actor: w.helpApp },
    });

    // Discovery says the grant exists.
    const discovery = (await (await w.routed('/.well-known/openid-configuration')).json()) as { grant_types_supported: string[] };
    expect(discovery.grant_types_supported).toContain(EXCHANGE);
    expect(discovery.grant_types_supported).toContain('authorization_code');
  });

  it('refuses the actor once the platform re-delivers the host’s grants empty', async () => {
    const w = await world();
    const ann = await signedInToDesk(w);
    const assertion = ((await (await stageA(w, ann.idToken)).json()) as { access_token: string }).access_token;
    expect((await stageB(w, assertion)).status).toBe(200);

    expect((await w.delegations('')).status).toBe(200);
    const revoked = await stageB(w, assertion);
    expect(revoked.status).toBe(400);
    expect(((await revoked.json()) as { error: string }).error).toBe('invalid_grant');
    // And the host can no longer start one either.
    const again = await stageA(w, ann.idToken);
    expect(((await again.json()) as { error: string }).error).toBe('invalid_target');
    // The delivery is rows, never a `cfg:` entry.
    const dump = await dumpOf(w.scope);
    expect(dump['delegation_grant']).toEqual([]);
    expect(dump['config']!.some((r) => r.includes('substrat:delegations'))).toBe(false);
  });

  it('refuses a client that authenticates badly, before it can learn anything', async () => {
    const w = await world();
    const ann = await signedInToDesk(w);
    const res = await exchange(w, { id: w.desk.id, secret: 'not-the-secret' }, {
      subject_token: ann.idToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      audience: w.help.id,
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_client');
  });

  it('refuses a subject token whose signature is not the issuer’s', async () => {
    const w = await world();
    const ann = await signedInToDesk(w);
    // The real id_token's header and claims, under another signature.
    const [header, claims] = ann.idToken.split('.');
    const forged = `${header}.${claims}.${b64url(crypto.getRandomValues(new Uint8Array(64)).buffer as ArrayBuffer)}`;
    const res = await stageA(w, forged);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    // The twin: the token as issued is accepted.
    expect((await stageA(w, ann.idToken)).status).toBe(200);
  });
});
