import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';
import { createAdminApi } from '../src/admin-api.js';
import {
  PROVIDER_CATALOGUE,
  discoveryUrlOf,
  genericProvidersFrom,
  isReservedProviderId,
  publicProvidersFrom,
  readProviders,
  socialProvidersFrom,
  trustedProvidersFrom,
  type ProviderRow,
} from '../src/providers.js';
import type { SqlExec } from '../src/introspect.js';
import type { SessionSubject } from '../src/do-contract.js';

/**
 * The UPSTREAM provider registry — the dashboard's "Sign-in providers" panel.
 *
 * Two things need proving, and they are different in kind. The REGISTRY is ours: an admin
 * gate, a stored credential that never comes back out, and an edit that does not require
 * re-pasting it. The WIRING is Better Auth's: rows have to become a `socialProviders` config
 * that the library actually mounts, because a row that configures nothing is the failure this
 * whole feature would have — a panel that looks right and a login screen that cannot use it.
 * So the last test drives `/sign-in/social` and reads the authorize URL it hands back.
 */

const ORIGIN = 'http://localhost:8877';
const ADMIN = { email: 'admin@auth.test', password: 'admin-demo-pass', name: 'Demo Admin' };
const MEMBER = { email: 'member@auth.test', password: 'member-demo-pass', name: 'Plain Member' };
const TENANT = '11111111-2222-3333-4444-555555555555';

let db: Database.Database;
let sql: SqlExec;
let auth: Auth;
let api: ReturnType<typeof createAdminApi>;

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

async function signInAs(who: { email: string; password: string }): Promise<string> {
  const res = await call('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(who),
  });
  expect(res.status).toBe(200);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

const adminCall = (path: string, cookie: string, init?: RequestInit): Promise<Response> =>
  Promise.resolve(
    api.request(`http://localhost${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', cookie, ...init?.headers },
    }),
  );

interface WireProvider {
  id: string;
  clientId: string;
  clientSecretSet: boolean;
  tenantId: string | null;
  issuer: string | null;
  label: string | null;
  allowSignup: boolean;
  trustEmail: boolean;
  disabled: boolean;
  callbackPath: string;
}

const listProviders = async (cookie: string): Promise<WireProvider[]> =>
  ((await (await adminCall('/providers', cookie)).json()) as { providers: WireProvider[] }).providers;

const enableMicrosoft = (cookie: string, body: Record<string, unknown> = {}) =>
  adminCall('/providers/microsoft', cookie, {
    method: 'PUT',
    body: JSON.stringify({
      clientId: 'entra-app-id',
      clientSecret: 'entra-secret',
      tenantId: TENANT,
      allowSignup: true,
      trustEmail: false,
      disabled: false,
      ...body,
    }),
  });

/** Save a CUSTOM (generic OIDC) provider, as the panel's “+ Custom (OIDC)” flow does. */
const addAcme = (cookie: string, body: Record<string, unknown> = {}, id = 'acme') =>
  adminCall(`/providers/${id}`, cookie, {
    method: 'PUT',
    body: JSON.stringify({
      clientId: 'acme-client-id',
      clientSecret: 'acme-secret',
      issuer: 'https://id.acme.test',
      label: 'Acme SSO',
      allowSignup: true,
      trustEmail: false,
      disabled: false,
      ...body,
    }),
  });

/**
 * Enable Supabase, as the panel's named catalogue button does: an issuer URL and a credential,
 * and deliberately NO label — that one is the catalogue's, and the route fills it in.
 */
const addSupabase = (cookie: string, body: Record<string, unknown> = {}) =>
  adminCall('/providers/supabase', cookie, {
    method: 'PUT',
    body: JSON.stringify({
      clientId: 'supabase-client-id',
      clientSecret: 'supabase-secret',
      issuer: SUPABASE_ISSUER,
      allowSignup: true,
      trustEmail: false,
      disabled: false,
      ...body,
    }),
  });

/** Build a fresh Better Auth over the CURRENT rows — what both runtimes do per request. */
function rebuild(): Auth {
  const rows = readProviders(sql);
  return buildAuth({
    database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
    secret: 'test-secret-000000000000000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: new MockEmailTransport(),
    sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    allowSignup: true,
    socialProviders: socialProvidersFrom(rows),
    genericProviders: genericProvidersFrom(rows),
    trustedProviders: trustedProvidersFrom(rows),
  });
}

const row = (over: Partial<ProviderRow> = {}): ProviderRow => ({
  provider_id: 'microsoft',
  client_id: 'entra-app-id',
  client_secret: 'entra-secret',
  tenant_id: TENANT,
  issuer: null,
  label: null,
  endpoints: null,
  allow_signup: 1,
  trust_email: 0,
  disabled: 0,
  updated_at: 1,
  ...over,
});

/** The discovery document the stubbed upstream serves — what a save resolves and stores. */
const ACME_DISCOVERY = {
  issuer: 'https://id.acme.test',
  authorization_endpoint: 'https://id.acme.test/oauth/authorize',
  token_endpoint: 'https://id.acme.test/oauth/token',
  userinfo_endpoint: 'https://id.acme.test/oauth/userinfo',
  jwks_uri: 'https://id.acme.test/.well-known/jwks.json',
};

/**
 * A Supabase project, as its OAuth 2.1 server actually presents itself: the issuer is the
 * project URL with `/auth/v1` on the end, and the project URL alone serves no discovery
 * document at all. That gap is the whole reason Supabase is a NAMED catalogue entry rather
 * than one more thing to type into the Custom (OIDC) door — see `SUPABASE_PROJECT` below,
 * which the stub deliberately 404s.
 */
const SUPABASE_PROJECT = 'https://abcdefghijklmnopqrst.supabase.co';
const SUPABASE_ISSUER = `${SUPABASE_PROJECT}/auth/v1`;
const SUPABASE_DISCOVERY = {
  issuer: SUPABASE_ISSUER,
  authorization_endpoint: `${SUPABASE_ISSUER}/oauth/authorize`,
  token_endpoint: `${SUPABASE_ISSUER}/oauth/token`,
  userinfo_endpoint: `${SUPABASE_ISSUER}/oauth/userinfo`,
  jwks_uri: `${SUPABASE_ISSUER}/.well-known/jwks.json`,
};

/** A GENERIC OIDC row — what a saved custom provider looks like in the table. */
const genericRow = (over: Partial<ProviderRow> = {}): ProviderRow =>
  row({
    provider_id: 'acme',
    client_id: 'acme-client-id',
    client_secret: 'acme-secret',
    tenant_id: null,
    issuer: 'https://id.acme.test',
    label: 'Acme SSO',
    endpoints: JSON.stringify(ACME_DISCOVERY),
    ...over,
  });

/**
 * A NAMED generic row: Supabase. Identical in kind to `genericRow` — the `issuer` column is
 * what makes a row generic — except that its id and its label come from the catalogue.
 */
const supabaseRow = (over: Partial<ProviderRow> = {}): ProviderRow =>
  genericRow({
    provider_id: 'supabase',
    client_id: 'supabase-client-id',
    client_secret: 'supabase-secret',
    issuer: SUPABASE_ISSUER,
    label: 'Supabase',
    endpoints: JSON.stringify(SUPABASE_DISCOVERY),
    ...over,
  });

/**
 * The upstreams' discovery documents, served from a fetch stub — a SAVE resolves discovery
 * (that is the design under test), so the admin tests need an upstream to answer. Every
 * request is counted by URL, which is what lets the sign-in test assert the runtime made NO
 * discovery fetch at all.
 */
const discoveryHits: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  discoveryHits.length = 0;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.includes('/.well-known/openid-configuration')) {
      discoveryHits.push(target);
      if (target === 'https://id.acme.test/.well-known/openid-configuration') {
        return Response.json(ACME_DISCOVERY);
      }
      if (target === 'https://impostor.acme.test/.well-known/openid-configuration') {
        // Serves ACME's document verbatim — a discovery document claiming someone else's issuer.
        return Response.json(ACME_DISCOVERY);
      }
      if (target === 'https://sneaky.acme.test/.well-known/openid-configuration') {
        // A consistent issuer, but an endpoint downgraded to plain HTTP off loopback.
        return Response.json({
          issuer: 'https://sneaky.acme.test',
          authorization_endpoint: 'http://sneaky.acme.test/oauth/authorize',
          token_endpoint: 'https://sneaky.acme.test/oauth/token',
        });
      }
      if (target === `${SUPABASE_ISSUER}/.well-known/openid-configuration`) {
        return Response.json(SUPABASE_DISCOVERY);
      }
      // The project URL WITHOUT `/auth/v1` — Supabase serves nothing here, which is exactly
      // the mistake the named entry's hint exists to prevent.
      if (target === `${SUPABASE_PROJECT}/.well-known/openid-configuration`) {
        return new Response('not found', { status: 404 });
      }
      if (target === 'http://localhost:8080/realms/dev/.well-known/openid-configuration') {
        return Response.json({
          issuer: 'http://localhost:8080/realms/dev',
          authorization_endpoint: 'http://localhost:8080/realms/dev/protocol/openid-connect/auth',
          token_endpoint: 'http://localhost:8080/realms/dev/protocol/openid-connect/token',
        });
      }
      return new Response('not found', { status: 404 });
    }
    return realFetch(input as never, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

beforeEach(async () => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  sql = sqlExecOf(db);
  auth = rebuild();
  for (const who of [ADMIN, MEMBER]) {
    const created = await auth.api.signUpEmail({ body: who });
    db.prepare('UPDATE user SET role = ?, email_verified = 1 WHERE id = ?').run(
      who === MEMBER ? 'user' : 'admin',
      created.user.id,
    );
  }
  const session = (headers: Headers): Promise<SessionSubject | null> =>
    auth.api.getSession({ headers: headers as never }).then((s) => {
      const u = s?.user as { id: string; email?: string; name?: string; role?: string } | undefined;
      return u ? { sub: u.id, email: u.email ?? null, name: u.name ?? null, role: u.role ?? null } : null;
    });
  api = createAdminApi({ sql, session, effectiveCfg: () => ({}), auth: () => auth.api as never });
});

describe('the providers admin surface', () => {
  it('serves the catalogue with what is configured against it', async () => {
    const cookie = await signInAs(ADMIN);
    const body = (await (await adminCall('/providers', cookie)).json()) as {
      catalogue: { id: string }[];
      providers: WireProvider[];
    };
    expect(body.catalogue.map((entry) => entry.id)).toContain('microsoft');
    expect(body.providers).toEqual([]);
  });

  it('is administrator-only, like every other verb on this surface', async () => {
    const member = await signInAs(MEMBER);
    expect((await enableMicrosoft(member)).status).toBe(403);
    expect((await adminCall('/providers', member)).status).toBe(403);
    // No session at all: refused before the role is even considered.
    expect((await adminCall('/providers', '')).status).toBe(401);
  });

  it('enables a provider and never hands the secret back', async () => {
    const cookie = await signInAs(ADMIN);
    expect((await enableMicrosoft(cookie)).status).toBe(201);

    const [provider] = await listProviders(cookie);
    expect(provider).toMatchObject({
      id: 'microsoft',
      clientId: 'entra-app-id',
      clientSecretSet: true,
      tenantId: TENANT,
      callbackPath: '/api/auth/callback/microsoft',
    });
    // The credential is in the row and nowhere in the response — the panel is told only that
    // one exists, exactly as it is for a relying party's secret.
    expect(JSON.stringify(provider)).not.toContain('entra-secret');
    expect(readProviders(sql)[0]?.client_secret).toBe('entra-secret');
  });

  it('keeps the stored secret when an edit omits it', async () => {
    const cookie = await signInAs(ADMIN);
    await enableMicrosoft(cookie);
    // The panel sends no `clientSecret` when the field is untouched: flipping a toggle must
    // not require re-pasting a credential the operator may no longer have.
    const edited = await adminCall('/providers/microsoft', cookie, {
      method: 'PUT',
      body: JSON.stringify({ clientId: 'entra-app-id', tenantId: TENANT, allowSignup: false, trustEmail: true, disabled: false }),
    });
    expect(edited.status).toBe(200);
    expect(readProviders(sql)[0]).toMatchObject({ client_secret: 'entra-secret', trust_email: 1, allow_signup: 0 });
  });

  it('refuses a first save with no secret, and an empty one on any save', async () => {
    const cookie = await signInAs(ADMIN);
    const bare = await adminCall('/providers/microsoft', cookie, {
      method: 'PUT',
      body: JSON.stringify({ clientId: 'entra-app-id', allowSignup: true, trustEmail: false, disabled: false }),
    });
    expect(bare.status).toBe(400);
    expect(readProviders(sql)).toEqual([]);

    await enableMicrosoft(cookie);
    // An empty string is a form field nobody typed in, not an instruction to clear the
    // credential — the schema rejects it rather than writing a provider that cannot sign in.
    const cleared = await enableMicrosoft(cookie, { clientSecret: '' });
    expect(cleared.status).toBe(400);
    expect(readProviders(sql)[0]?.client_secret).toBe('entra-secret');
  });

  it('refuses an off-catalogue provider that brings no issuer — it is neither kind', async () => {
    const cookie = await signInAs(ADMIN);
    const res = await adminCall('/providers/definitely-not-a-provider', cookie, {
      method: 'PUT',
      body: JSON.stringify({ clientId: 'x', clientSecret: 'y', allowSignup: true, trustEmail: false, disabled: false }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('issuer');
  });

  it('saves a custom OIDC provider, resolving its discovery document at save time', async () => {
    const cookie = await signInAs(ADMIN);
    expect((await addAcme(cookie)).status).toBe(201);
    // Discovery happened HERE, once — the runtime never fetches it (the sign-in test holds
    // the other half of that claim).
    expect(discoveryHits).toEqual(['https://id.acme.test/.well-known/openid-configuration']);
    expect(JSON.parse(readProviders(sql)[0]!.endpoints!)).toMatchObject({
      authorization_endpoint: 'https://id.acme.test/oauth/authorize',
      token_endpoint: 'https://id.acme.test/oauth/token',
    });

    const [provider] = await listProviders(cookie);
    expect(provider).toMatchObject({
      id: 'acme',
      clientId: 'acme-client-id',
      clientSecretSet: true,
      issuer: 'https://id.acme.test',
      label: 'Acme SSO',
      // Same callback shape as a catalogue provider — the generic plugin registers its
      // providers as first-class social providers, so there is ONE redirect-URI rule.
      callbackPath: '/api/auth/callback/acme',
    });
    expect(JSON.stringify(provider)).not.toContain('acme-secret');

    // An edit that does not change the issuer keeps the stored endpoints without asking the
    // upstream again — flipping a toggle must not depend on the upstream being up.
    discoveryHits.length = 0;
    expect((await addAcme(cookie, { trustEmail: true })).status).toBe(200);
    expect(discoveryHits).toEqual([]);
    expect(readProviders(sql)[0]!.endpoints).toBeTruthy();
  });

  it('refuses a save whose issuer serves no usable discovery document', async () => {
    const cookie = await signInAs(ADMIN);
    const res = await addAcme(cookie, { issuer: 'https://not-an-issuer.test' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('discovery');
    expect(readProviders(sql)).toEqual([]);
  });

  it('refuses a discovery document that lies about its issuer or downgrades an endpoint', async () => {
    const cookie = await signInAs(ADMIN);
    // The document at impostor.acme.test declares id.acme.test's issuer. That issuer becomes
    // the account namespace (`accountIssuer` + the upstream's `sub`), so accepting it would
    // let one upstream squat another configured provider's accounts.
    const impostor = await addAcme(cookie, { issuer: 'https://impostor.acme.test' });
    expect(impostor.status).toBe(400);
    expect(((await impostor.json()) as { error: string }).error).toContain('issuer');
    // An HTTPS issuer whose document points an endpoint at plain HTTP off loopback: the
    // endpoints are where people, authorization codes and the client secret actually go, so
    // each one passes the same HTTPS-or-loopback rule the issuer URL did.
    const sneaky = await addAcme(cookie, { issuer: 'https://sneaky.acme.test' });
    expect(sneaky.status).toBe(400);
    expect(((await sneaky.json()) as { error: string }).error).toContain('https');
    expect(readProviders(sql)).toEqual([]);
  });

  it('refuses the ids and issuers that would go wrong later, at save time', async () => {
    const cookie = await signInAs(ADMIN);
    // A built-in provider's name, as a custom row: it would silently shadow the library's
    // GitLab — same button, different endpoints.
    expect((await addAcme(cookie, {}, 'gitlab')).status).toBe(400);
    // The id is the callback path segment, so it has to be a path-safe slug.
    expect((await addAcme(cookie, {}, 'Not%20A%20Slug')).status).toBe(400);
    // A custom provider's button needs a name.
    expect((await addAcme(cookie, { label: undefined })).status).toBe(400);
    // The discovery document decides where people and authorization codes are sent, so the
    // issuer must be https (loopback excepted) and must not be a pasted authorize URL.
    expect((await addAcme(cookie, { issuer: 'http://id.acme.test' })).status).toBe(400);
    expect((await addAcme(cookie, { issuer: 'https://id.acme.test/authorize?client_id=x' })).status).toBe(400);
    expect((await addAcme(cookie, { issuer: 'not a url' })).status).toBe(400);
    // And a catalogue id takes no issuer at all — the library owns those endpoints.
    expect((await enableMicrosoft(cookie, { issuer: 'https://id.acme.test' })).status).toBe(400);
    expect(readProviders(sql)).toEqual([]);

    // The loopback exception: a local Keycloak in dev is a real use, and refused-for-https
    // there would only teach people to deploy first and configure blind.
    expect((await addAcme(cookie, { issuer: 'http://localhost:8080/realms/dev' })).status).toBe(201);
  });

  it('enables Supabase from the catalogue — a named entry that is a generic row underneath', async () => {
    const cookie = await signInAs(ADMIN);
    expect((await addSupabase(cookie)).status).toBe(201);
    // Discovery ran at SAVE time, against the issuer the operator gave — the same one path a
    // custom provider takes. Nothing about this row is special at runtime.
    expect(discoveryHits).toEqual([`${SUPABASE_ISSUER}/.well-known/openid-configuration`]);

    const [provider] = await listProviders(cookie);
    expect(provider).toMatchObject({
      id: 'supabase',
      issuer: SUPABASE_ISSUER,
      // The catalogue's, not the operator's — the request sent no label at all.
      label: 'Supabase',
      clientSecretSet: true,
      callbackPath: '/api/auth/callback/supabase',
    });
    expect(JSON.stringify(provider)).not.toContain('supabase-secret');
    // The directory field belongs to Entra; an issuer URL already names one project.
    expect(provider!.tenantId).toBeNull();
  });

  it('refuses Supabase without an issuer, and refuses the project URL that serves no discovery', async () => {
    const cookie = await signInAs(ADMIN);
    // A named generic entry is not a built-in: the issuer is the one thing the catalogue
    // cannot know, so its absence is refused rather than defaulted.
    const bare = await addSupabase(cookie, { issuer: undefined });
    expect(bare.status).toBe(400);
    expect(((await bare.json()) as { error: string }).error).toContain('issuer');

    // The mistake the hint is for: the project URL an operator has to hand is NOT the issuer,
    // and Supabase serves no discovery document there. It fails at save time, in the form,
    // rather than at the first person's sign-in.
    const projectUrl = await addSupabase(cookie, { issuer: SUPABASE_PROJECT });
    expect(projectUrl.status).toBe(400);
    expect(((await projectUrl.json()) as { error: string }).error).toContain('discovery');
    expect(readProviders(sql)).toEqual([]);
  });

  it('removes a provider, and says so when there is nothing to remove', async () => {
    const cookie = await signInAs(ADMIN);
    await enableMicrosoft(cookie);
    expect((await adminCall('/providers/microsoft', cookie, { method: 'DELETE' })).status).toBe(200);
    expect(readProviders(sql)).toEqual([]);
    expect((await adminCall('/providers/microsoft', cookie, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('rows becoming Better Auth config', () => {
  it('carries the directory through and inverts the sign-up decision', () => {
    expect(socialProvidersFrom([row()])).toEqual({
      microsoft: {
        clientId: 'entra-app-id',
        clientSecret: 'entra-secret',
        tenantId: TENANT,
        // `allow_signup` on ⇒ Better Auth's `disableSignUp` off. The inversion is the bug
        // this asserts against: getting it backwards silently admits everyone, or nobody.
        disableSignUp: false,
      },
    });
    expect(socialProvidersFrom([row({ allow_signup: 0 })])?.microsoft?.disableSignUp).toBe(true);
    // No directory ⇒ no `tenantId` key at all, which is Better Auth's multi-tenant `common`.
    expect(socialProvidersFrom([row({ tenant_id: null })])?.microsoft).not.toHaveProperty('tenantId');
  });

  it('leaves out a disabled row, an unknown provider, and offers nothing when empty', () => {
    expect(socialProvidersFrom([row({ disabled: 1 })])).toBeUndefined();
    expect(socialProvidersFrom([row({ provider_id: 'myspace' })])).toBeUndefined();
    // Undefined rather than an empty object: an issuer with no upstream must not advertise one.
    expect(socialProvidersFrom([])).toBeUndefined();
    expect(publicProvidersFrom([row({ disabled: 1 })])).toEqual([]);
  });

  it('trusts a provider for account linking only when asked', () => {
    expect(trustedProvidersFrom([row()])).toEqual([]);
    expect(trustedProvidersFrom([row({ trust_email: 1 })])).toEqual(['microsoft']);
    expect(trustedProvidersFrom([row({ trust_email: 1, disabled: 1 })])).toEqual([]);
  });

  it('tells the signed-out login screen the id and label, and nothing else', () => {
    expect(publicProvidersFrom([row()])).toEqual([{ id: 'microsoft', label: 'Microsoft' }]);
  });

  it('splits generic rows into the genericOAuth config, and out of socialProviders', () => {
    const rows = [row(), genericRow()];
    // The catalogue row stays a social provider; the generic one must NOT appear there —
    // Better Auth would read `acme` as a built-in id and fail on its missing endpoints.
    expect(Object.keys(socialProvidersFrom(rows) ?? {})).toEqual(['microsoft']);
    const [acme] = genericProvidersFrom(rows)!;
    expect(acme).toMatchObject({
      providerId: 'acme',
      name: 'Acme SSO',
      // Explicit endpoints from the stored discovery document — deliberately NOT
      // `discoveryUrl`, which the plugin would fetch on every per-request rebuild.
      authorizationUrl: 'https://id.acme.test/oauth/authorize',
      tokenUrl: 'https://id.acme.test/oauth/token',
      userInfoUrl: 'https://id.acme.test/oauth/userinfo',
      accountIssuer: 'https://id.acme.test',
      clientId: 'acme-client-id',
      clientSecret: 'acme-secret',
      scopes: ['openid', 'profile', 'email'],
      pkce: true,
      disableSignUp: false,
    });
    expect(acme).not.toHaveProperty('discoveryUrl');
    // The subject is the id_token's `sub` (mapped to `id` by the plugin's userinfo reader) —
    // never a field switch at runtime, which would change an account's identity.
    const subjectOf = acme!.accountSubject as (ctx: { profile: Record<string, unknown> }) => string;
    expect(subjectOf({ profile: { sub: 'user-1', id: 'wrong' } })).toBe('user-1');
    expect(subjectOf({ profile: { id: 'user-2' } })).toBe('user-2');
    // The same knife cuts both ways: a store with only a generic row mounts no socialProviders.
    expect(socialProvidersFrom([genericRow()])).toBeUndefined();
    expect(genericProvidersFrom([row()])).toBeUndefined();
    expect(genericProvidersFrom([genericRow({ disabled: 1 })])).toBeUndefined();
    // A generic row that somehow lost its endpoints is not offered — a provider with no
    // authorize URL is a button that errors, not a provider.
    expect(genericProvidersFrom([genericRow({ endpoints: null })])).toBeUndefined();
  });

  it('mounts a NAMED generic row (Supabase) exactly as it mounts a custom one', () => {
    const rows = [row(), supabaseRow()];
    // `supabase` is not a provider Better Auth ships, so it must never reach socialProviders:
    // the library would read it as a built-in id and fail on the endpoints it has none of.
    expect(Object.keys(socialProvidersFrom(rows) ?? {})).toEqual(['microsoft']);
    const [supabase] = genericProvidersFrom(rows)!;
    expect(supabase).toMatchObject({
      providerId: 'supabase',
      name: 'Supabase',
      authorizationUrl: `${SUPABASE_ISSUER}/oauth/authorize`,
      tokenUrl: `${SUPABASE_ISSUER}/oauth/token`,
      userInfoUrl: `${SUPABASE_ISSUER}/oauth/userinfo`,
      // The account namespace is the issuer Supabase declares — the project, not the host.
      // Two projects on `supabase.co` are two directories, and this is what keeps them apart.
      accountIssuer: SUPABASE_ISSUER,
      clientId: 'supabase-client-id',
      scopes: ['openid', 'profile', 'email'],
      pkce: true,
    });
    expect(supabase).not.toHaveProperty('discoveryUrl');
    // The login screen labels it from the CATALOGUE, which is the half a named entry adds.
    expect(publicProvidersFrom([supabaseRow()])).toEqual([{ id: 'supabase', label: 'Supabase' }]);
    expect(trustedProvidersFrom([supabaseRow({ trust_email: 1 })])).toEqual(['supabase']);
  });

  it('keeps the catalogue honest about which entries the library actually ships', () => {
    // The two kinds of catalogue entry are decided by whether Better Auth has a built-in, and
    // getting that backwards fails QUIETLY in both directions. An entry with no `issuerField`
    // goes into `socialProviders` under its id: if the library does not ship it, that config
    // names endpoints nobody has. An entry WITH one becomes a `genericOAuth` provider, and
    // the plugin prepends its providers to the built-in list: if the library DOES ship that
    // id, ours silently shadows it — the same button, someone else's endpoints, and a bug
    // that reads as "Supabase is broken" rather than "two things share a name".
    //
    // So this is the guard for the day Better Auth adds a built-in we have named generically.
    for (const entry of PROVIDER_CATALOGUE) {
      expect({ id: entry.id, builtIn: isReservedProviderId(entry.id) }).toEqual({
        id: entry.id,
        builtIn: !entry.issuerField,
      });
    }
  });

  it('derives the discovery URL from an issuer without doubling a pasted one', () => {
    expect(discoveryUrlOf('https://id.acme.test')).toBe('https://id.acme.test/.well-known/openid-configuration');
    expect(discoveryUrlOf('https://id.acme.test/')).toBe('https://id.acme.test/.well-known/openid-configuration');
    expect(discoveryUrlOf('https://kc.acme.test/realms/main')).toBe(
      'https://kc.acme.test/realms/main/.well-known/openid-configuration',
    );
    expect(discoveryUrlOf('https://id.acme.test/.well-known/openid-configuration')).toBe(
      'https://id.acme.test/.well-known/openid-configuration',
    );
  });

  it('treats a generic provider like any other for trust and the login screen', () => {
    expect(trustedProvidersFrom([genericRow({ trust_email: 1 })])).toEqual(['acme']);
    expect(publicProvidersFrom([genericRow()])).toEqual([{ id: 'acme', label: 'Acme SSO' }]);
  });
});

describe('the login screen', () => {
  it('cannot start a social sign-in until a provider is configured', async () => {
    const res = await call('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'microsoft', callbackURL: '/' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('sends the browser to the configured directory once one is', async () => {
    const cookie = await signInAs(ADMIN);
    await enableMicrosoft(cookie);
    // The rebuild is the point: both runtimes construct Better Auth per request, which is what
    // makes a provider added in the dashboard answer on the very next one.
    auth = rebuild();

    const res = await call('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'microsoft', callbackURL: '/' }),
    });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const authorize = new URL(url);
    expect(authorize.hostname).toBe('login.microsoftonline.com');
    // The stored directory, not `common` — the whole reason the panel asks for it.
    expect(authorize.pathname).toContain(TENANT);
    expect(authorize.searchParams.get('client_id')).toBe('entra-app-id');
    // The redirect URI the panel tells the operator to register, built by the library itself.
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/microsoft`);
  });

  it('sends the browser to a CUSTOM provider — without a runtime discovery fetch', async () => {
    const cookie = await signInAs(ADMIN);
    expect((await addAcme(cookie)).status).toBe(201);
    auth = rebuild();
    discoveryHits.length = 0;

    const res = await call('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'acme', callbackURL: '/' }),
    });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const authorize = new URL(url);
    // The authorize endpoint comes from the STORED document, and the sign-in made no
    // discovery fetch — this is the property the per-request rebuild depends on: a
    // discovery URL handed to the plugin is fetched on every rebuild, and an upstream
    // whose discovery routes back to this issuer (another auth server like this one)
    // turns that into unbounded recursion. Observed as an OOM, not theorised.
    expect(discoveryHits).toEqual([]);
    expect(`${authorize.origin}${authorize.pathname}`).toBe('https://id.acme.test/oauth/authorize');
    expect(authorize.searchParams.get('client_id')).toBe('acme-client-id');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/acme`);
    expect(authorize.searchParams.get('scope')).toContain('openid');
    // OAuth 2.1's PKCE, pinned in `genericProvidersFrom` rather than left to a default.
    expect(authorize.searchParams.get('code_challenge')).toBeTruthy();
  });

  it('sends the browser to the Supabase project a named catalogue row configured', async () => {
    const cookie = await signInAs(ADMIN);
    expect((await addSupabase(cookie)).status).toBe(201);
    auth = rebuild();
    discoveryHits.length = 0;

    const res = await call('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'supabase', callbackURL: '/' }),
    });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const authorize = new URL(url);
    expect(discoveryHits).toEqual([]);
    // The project's own OAuth 2.1 authorize endpoint, from the document stored at save time.
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${SUPABASE_ISSUER}/oauth/authorize`);
    expect(authorize.searchParams.get('client_id')).toBe('supabase-client-id');
    // The redirect URI the panel tells the operator to register in the Supabase dashboard —
    // the id is the path segment, which is why a catalogue entry fixes it.
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/supabase`);
    expect(authorize.searchParams.get('code_challenge')).toBeTruthy();
  });
});
