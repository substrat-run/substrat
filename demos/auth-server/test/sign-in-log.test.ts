import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';
import { genericProvidersFrom, readProviders, socialProvidersFrom, trustedProvidersFrom } from '../src/providers.js';
import {
  SIGN_IN_LOG_LIMIT,
  authorityOf,
  readSignInLog,
  recordSignInAttempt,
  signInLoggerFor,
  type SignInAttempt,
} from '../src/sign-in-log.js';
import type { SqlExec } from '../src/introspect.js';

/**
 * THE SIGN-IN LOG — what the issuer remembers about an attempt that did not work.
 *
 * The feature exists for one question an operator could not previously answer: "a user cannot
 * sign in with Microsoft". Every fact that would settle it used to be destroyed immediately —
 * the upstream's refusal goes onto a redirect and is read by the browser, the authority this
 * issuer addressed exists only in an address bar mid-navigation, and a hosted install's
 * `console.log` is not somewhere the operator who configured the provider can look.
 *
 * So these tests are written as that operator's reads, and the one that carries the feature is
 * the second: a provider refusing at ITS OWN end, whose `error_description` is the diagnosis.
 * It is also the case no unit test over the writer could reach, because what makes it work is
 * that Better Auth's callback signals every outcome — success and refusal alike — by THROWING
 * a redirect, and only an after-hook on the dispatch pipeline sees those. A hook written
 * against the return value would log nothing here and pass its own tests.
 *
 * The last test is the security half, and it is a property rather than an example: nothing the
 * log stores may contain the material of a sign-in. The authorization URL's query carries the
 * PKCE challenge and the signed authorize request, which is exactly why only its other half is
 * kept.
 */

const ORIGIN = 'http://localhost:8877';
const ADMIN = { email: 'admin@auth.test', password: 'admin-demo-pass', name: 'Demo Admin' };

/** The stubbed upstream — a generic OIDC row, saved the way the providers panel saves one.
 *  A catalogue row (Microsoft) would need Entra reachable; what is under test is the hook, and
 *  both kinds land on the same two routes (`genericOAuth` registers as a social provider). */
const ACME_DISCOVERY = {
  issuer: 'https://id.acme.test',
  authorization_endpoint: 'https://id.acme.test/realms/staff/protocol/openid-connect/auth',
  token_endpoint: 'https://id.acme.test/oauth/token',
  userinfo_endpoint: 'https://id.acme.test/oauth/userinfo',
};

let db: Database.Database;
let sql: SqlExec;
let auth: Auth;
let adminId: string;
let upstreamProfile: Record<string, unknown>;

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

const cookiesOf = (res: Response): string[] =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .filter((pair) => !pair.endsWith('='));

/** Better Auth over the current rows, with the log wired as both runtimes wire it. */
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
    autoLinkAccounts: true,
    recordSignIn: signInLoggerFor(sql),
  });
}

function saveAcme(over: { trust_email?: 0 | 1 } = {}): void {
  db.prepare(
    `INSERT INTO identity_provider
       (provider_id, client_id, client_secret, tenant_id, issuer, label, endpoints, allow_signup, trust_email, disabled, updated_at)
     VALUES ('acme', 'acme-client-id', 'acme-secret', NULL, ?, 'Acme SSO', ?, 1, ?, 0, 1)
     ON CONFLICT(provider_id) DO UPDATE SET trust_email = excluded.trust_email`,
  ).run(ACME_DISCOVERY.issuer, JSON.stringify(ACME_DISCOVERY), over.trust_email ?? 0);
  auth = rebuild();
}

/** Start a federated sign-in, returning the authorization URL and the cookies it set. */
async function startSignIn(body: Record<string, unknown> = {}): Promise<{ url: string; cookie: string }> {
  const res = await call('/api/auth/sign-in/social', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'acme', callbackURL: '/', errorCallbackURL: '/?social_error=1', ...body }),
  });
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  return { url, cookie: cookiesOf(res).join('; ') };
}

const log = (): SignInAttempt[] => readSignInLog(sql, { limit: 50 }).attempts;

/** base64url — PKCE's encoding. OAuth 2.1 makes `code_challenge` mandatory on authorize. */
function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target === ACME_DISCOVERY.token_endpoint) {
      return Response.json({ access_token: 'an-upstream-access-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (target === ACME_DISCOVERY.userinfo_endpoint) return Response.json(upstreamProfile);
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
  const created = await auth.api.signUpEmail({ body: ADMIN });
  adminId = created.user.id;
  db.prepare("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?").run(adminId);
  upstreamProfile = { sub: 'acme-subject-1', email: ADMIN.email, email_verified: true, name: ADMIN.name };
  db.prepare('DELETE FROM sign_in_attempt').run();
});

describe('the hop out', () => {
  it('records where the person was actually sent', async () => {
    saveAcme();

    await startSignIn();

    expect(log()).toMatchObject([
      {
        method: 'acme',
        outcome: 'started',
        phase: 'sign-in',
        // The authority AND the endpoint path — this is the field that distinguishes Entra's
        // `common` from a pinned directory, and a Keycloak realm from another realm.
        authority: 'id.acme.test/realms/staff/protocol/openid-connect/auth',
        error: null,
      },
    ]);
  });

  it('records a refusal that happens before anyone leaves — the button that does nothing', async () => {
    // No provider row at all: the enabled list is empty, so Better Auth has no `acme`.
    const res = await call('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'acme', callbackURL: '/' }),
    });

    expect(res.status).toBe(404);
    expect(log()).toMatchObject([{ method: 'acme', outcome: 'failed', phase: 'sign-in' }]);
    expect(log()[0]?.error).toBeTruthy();
  });
});

describe('the hop back', () => {
  /**
   * THE CASE THE FEATURE IS FOR. The upstream refused at its own end and said why — this is
   * the shape of every `AADSTS…` Entra answers with, and that sentence is the diagnosis. It
   * reaches `/callback/:id` as query parameters, goes straight back out on a redirect, and was
   * previously read by nobody but the browser.
   */
  it("keeps the upstream's own reason, verbatim", async () => {
    saveAcme();
    const { url, cookie } = await startSignIn();
    const state = new URL(url).searchParams.get('state');

    const res = await call(
      `/api/auth/callback/acme?error=invalid_client&error_description=${encodeURIComponent(
        'AADSTS700016: Application with identifier was not found in the directory.',
      )}&state=${state}`,
      { headers: { cookie } },
    );

    expect(res.status).toBe(302);
    expect(log()[0]).toMatchObject({
      method: 'acme',
      outcome: 'failed',
      phase: 'callback',
      error: 'invalid_client',
      errorDescription: 'AADSTS700016: Application with identifier was not found in the directory.',
    });
  });

  it("records Better Auth's OWN refusal — the one an operator reads as 'it just fails'", async () => {
    saveAcme();
    // The local account is unverified, the provider is untrusted: an implicit join is refused
    // (`account not linked`), which is the single most common federated-sign-in wall.
    db.prepare('UPDATE user SET email_verified = 0 WHERE id = ?').run(adminId);
    const { url, cookie } = await startSignIn();
    const state = new URL(url).searchParams.get('state');

    const res = await call(`/api/auth/callback/acme?code=an-authorization-code&state=${state}`, {
      headers: { cookie },
    });

    expect(res.status).toBe(302);
    expect(log()[0]).toMatchObject({ method: 'acme', outcome: 'failed', phase: 'callback' });
    expect(log()[0]?.error).toContain('account_not_linked');
  });

  it('records a success, with the account it resolved to', async () => {
    saveAcme({ trust_email: 1 });
    const { url, cookie } = await startSignIn();
    const state = new URL(url).searchParams.get('state');

    const res = await call(`/api/auth/callback/acme?code=an-authorization-code&state=${state}`, {
      headers: { cookie },
    });

    expect(res.status).toBe(302);
    // Newest first: the callback, then the sign-in that started it.
    expect(log()).toMatchObject([
      { method: 'acme', outcome: 'succeeded', phase: 'callback', userId: adminId, error: null },
      { method: 'acme', outcome: 'started', phase: 'sign-in' },
    ]);
  });
});

describe('which application the person was trying to reach', () => {
  /**
   * The client id comes off the SIGNED authorize query the pending request travels in, so this
   * drives the real hand-off rather than handing the endpoint a string: `oauthProvider` verifies
   * that signature in a before-hook and answers 400 to an unsigned one, which is also why the
   * log reads the query rather than trusting a field.
   */
  it('names the relying party, from the request it was serving', async () => {
    saveAcme();
    const registered = await call('/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['http://localhost:5999/callback'],
        client_name: 'Sender',
        application_type: 'native',
      }),
    });
    const { client_id: clientId } = (await registered.json()) as { client_id: string };

    // A stranger arrives from that application: no session, so the plugin sends them to
    // `/login` with the whole request signed into the query. PKCE is mandatory on authorize
    // (OAuth 2.1), so a request without a challenge never gets that far.
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
    const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const authorize = await call(
      `/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: 'http://localhost:5999/callback',
        scope: 'openid profile',
        state: 'st-log',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })}`,
      { headers: { 'sec-fetch-mode': 'navigate' } },
    );
    const location = authorize.headers.get('location') ?? '';
    expect(location.startsWith('/login?')).toBe(true);
    const oauthQuery = new URL(`http://x${location}`).search.replace(/^\?/, '');

    // They press the provider button on that screen, which hands the request back.
    await startSignIn({ oauth_query: oauthQuery });

    expect(log()[0]).toMatchObject({ method: 'acme', outcome: 'started', clientId });
  });
});

describe('what a row may never carry', () => {
  it('keeps no part of the authorization URL that could replay the sign-in', async () => {
    saveAcme();
    const { url } = await startSignIn();
    const authorization = new URL(url);
    const challenge = authorization.searchParams.get('code_challenge');
    const state = authorization.searchParams.get('state');
    expect(challenge).toBeTruthy();
    expect(state).toBeTruthy();

    // Every cell of every row, as one string — so this cannot be passed by a field that was
    // added later and forgotten.
    const stored = JSON.stringify(db.prepare('SELECT * FROM sign_in_attempt').all());

    expect(stored).not.toContain(challenge);
    expect(stored).not.toContain(state);
    expect(stored).not.toContain('code_challenge');
  });
});

describe('the ring', () => {
  it('keeps the newest attempts and prunes the rest, so a debugging aid cannot grow unbounded', () => {
    for (let i = 0; i < SIGN_IN_LOG_LIMIT + 25; i += 1) {
      recordSignInAttempt(sql, { method: 'acme', outcome: 'started', phase: 'sign-in', authority: `host/${i}` });
    }

    const { total, attempts } = readSignInLog(sql, { limit: 1 });
    expect(total).toBe(SIGN_IN_LOG_LIMIT);
    // The newest survives; the oldest is gone.
    expect(attempts[0]?.authority).toBe(`host/${SIGN_IN_LOG_LIMIT + 24}`);
    expect(readSignInLog(sql, { limit: 100 }).attempts.some((a) => a.authority === 'host/0')).toBe(false);
  });

  it('cannot fail a sign-in, whatever the store does', () => {
    const broken: SqlExec = {
      exec() {
        throw new Error('no such table: sign_in_attempt');
      },
    };

    expect(() => recordSignInAttempt(broken, { method: 'acme', outcome: 'started', phase: 'sign-in' })).not.toThrow();
  });
});

describe('reading the log', () => {
  beforeEach(() => {
    recordSignInAttempt(sql, { method: 'acme', outcome: 'started', phase: 'sign-in' });
    recordSignInAttempt(sql, { method: 'microsoft', outcome: 'failed', phase: 'callback', error: 'invalid_client' });
    recordSignInAttempt(sql, { method: 'microsoft', outcome: 'succeeded', phase: 'callback' });
  });

  it('narrows to one method, and to the refusals — the two reads an operator makes', () => {
    expect(readSignInLog(sql, { limit: 50, method: 'microsoft' }).attempts).toHaveLength(2);
    expect(readSignInLog(sql, { limit: 50, outcome: 'failed' }).attempts).toMatchObject([
      { method: 'microsoft', error: 'invalid_client' },
    ]);
  });

  it('pages by id rather than offset, because the ring moves underneath a reader', () => {
    const first = readSignInLog(sql, { limit: 2 }).attempts;
    expect(first).toHaveLength(2);
    const next = readSignInLog(sql, { limit: 2, before: first[1]!.id }).attempts;
    expect(next.map((a) => a.id)).not.toContain(first[0]!.id);
    expect(next[0]!.id).toBeLessThan(first[1]!.id);
  });
});

describe('authorityOf', () => {
  it('separates a pinned Entra directory from the multi-tenant authority', () => {
    expect(authorityOf('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x')).toBe(
      'login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    expect(
      authorityOf('https://login.microsoftonline.com/8cbb7553-0000-0000-0000-000000000000/oauth2/v2.0/authorize?y=1'),
    ).toBe('login.microsoftonline.com/8cbb7553-0000-0000-0000-000000000000/oauth2/v2.0/authorize');
  });

  it('answers null rather than throwing on anything it cannot parse', () => {
    expect(authorityOf('not a url')).toBeNull();
    expect(authorityOf(null)).toBeNull();
  });
});
