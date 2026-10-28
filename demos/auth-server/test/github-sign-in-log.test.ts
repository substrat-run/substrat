import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener } from 'node:http';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { buildAuth, type Auth } from '../src/auth.js';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import type { SignInAttemptInput } from '../src/sign-in-log.js';
import type { SignInPolicy } from '../src/sign-in-policy.js';

const ORIGIN = 'http://localhost:8877';
const handler = createRequire(import.meta.url)('../postman/mocks/github/handler.cjs') as RequestListener;
const server = createServer(handler);
let upstream: string;
let db: Database.Database;
let auth: Auth;
let attempts: SignInAttemptInput[];
let calls: string[];
let mail: MockEmailTransport;
let policy: SignInPolicy | undefined;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  // CI uses the same fixture over real HTTP; an explicit URL exercises it through Postman.
  if (process.env.AUTH_DIAGNOSTICS_SIMULATION_URL) {
    upstream = process.env.AUTH_DIAGNOSTICS_SIMULATION_URL;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not listen');
  upstream = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server.listening) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (['github.com', 'api.github.com'].includes(url.hostname)) {
      calls.push(url.pathname);
      // Only change the destination: the real adapter serializes requests and parses responses.
      return realFetch(`${upstream}${url.pathname}${url.search}`, init);
    }
    throw new Error('Unexpected outbound request in GitHub fixture');
  }) as typeof fetch;
  db = new Database(':memory:');
  for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
  attempts = [];
  mail = new MockEmailTransport();
  policy = undefined;
  auth = fixtureAuth();
});

function fixtureAuth(disableSignUp = false) {
  return buildAuth({
    database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
    secret: 'test-secret-000000000000000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: mail,
    sender: { email: 'no-reply@example.test' },
    socialProviders: { github: { clientId: 'fixture-client', clientSecret: 'fixture-client-secret', disableSignUp } },
    recordSignIn: (attempt) => { attempts.push(attempt); },
    fetchSignInDiagnostic: (input, init) => globalThis.fetch(input, init),
    allowSignup: true,
    signInPolicyFor: () => policy,
  });
}

afterEach(() => {
  globalThis.fetch = realFetch;
  db.close();
});

function cookieOf(response: Response) { return response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '); }
function post(path: string, body: unknown, cookie = '') {
  return auth.handler(new Request(`${ORIGIN}/api/auth${path}`, { method: 'POST', headers: { cookie, origin: ORIGIN, 'content-type': 'application/json', 'sec-fetch-mode': 'cors' }, body: JSON.stringify(body) }) as never);
}
async function start(oauthQuery?: string) {
  const response = await auth.handler(new Request(`${ORIGIN}/api/auth/sign-in/social`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'github', callbackURL: '/', errorCallbackURL: '/?social_error=1', ...(oauthQuery ? { oauth_query: oauthQuery } : {}) }),
  }) as never);
  expect(response.status).toBe(200);
  const { url } = await response.json() as { url: string };
  const authorize = new URL(url);
  expect(authorize.searchParams.get('scope')).toContain('user:email');
  return {
    state: authorize.searchParams.get('state')!,
    cookie: response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '),
  };
}

async function complete(flow: Awaited<ReturnType<typeof start>>, code: string) {
  const response = await auth.handler(new Request(`${ORIGIN}/api/auth/callback/github?${new URLSearchParams({ code, state: flow.state })}`, {
    headers: { cookie: flow.cookie },
  }) as never);
  expect(response.status).toBe(302);
  return response;
}

describe('GitHub callback diagnostics', () => {
  it.each([
    ['forbidden', 'HTTP 403; check OAuth App user:email scope or GitHub App Email addresses: read permission'],
    ['unauthorized', 'HTTP 401; GitHub rejected the access token'],
    ['empty', 'HTTP 200; first-page counts: addresses=0, primary=0, verified=0; OAuth email scope=no'],
  ])('explains a missing email: %s', async (code, detail) => {
    const flow = await start();
    const response = await complete(flow, code);
    expect(new URL(response.headers.get('location')!, ORIGIN).pathname).toBe('/github-email');
    expect(attempts.at(-1)).toMatchObject({ outcome: 'failed', phase: 'callback', error: 'email_verification_required' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM user').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM session').get()).toEqual({ n: 0 });
    expect(attempts.at(-1)?.errorDescription).toContain('email absent');
    expect(attempts.at(-1)?.errorDescription).toContain(detail);
    expect(calls.filter((path) => path === '/user/emails')).toHaveLength(2);
    const logged = JSON.stringify(attempts);
    for (const sensitive of [flow.state, `fixture-${code}-secret`, 'fixture-client-secret', 'sensitive-upstream-body', 'private@example.test']) {
      expect(logged).not.toContain(sensitive);
    }
  });

  it('leaves private-email sign-in working, with no diagnostic request on success', async () => {
    const flow = await start();
    await complete(flow, 'success');
    expect(attempts.at(-1)).toMatchObject({ outcome: 'succeeded', phase: 'callback' });
    expect(calls.filter((path) => path === '/user/emails')).toHaveLength(1);
    expect(JSON.stringify(attempts)).not.toContain('private@example.test');
  });

  it('identifies a failed token exchange without attempting a profile or email check', async () => {
    await complete(await start(), 'invalid-code');
    expect(attempts.at(-1)).toMatchObject({
      outcome: 'failed', error: 'invalid_code', errorDescription: 'Token exchange returned no tokens',
    });
    expect(calls).toEqual(['/login/oauth/access_token']);
  });

  it('records the stage of an unexpected callback exception without its raw message', async () => {
    const flow = await start();
    await auth.handler(new Request(`${ORIGIN}/api/auth/callback/github?${new URLSearchParams({ code: 'profile-exception', state: flow.state })}`, {
      headers: { cookie: flow.cookie },
    }) as never).catch(() => undefined);
    expect(attempts.at(-1)).toMatchObject({
      outcome: 'failed', phase: 'callback', error: 'callback_exception',
      errorDescription: 'Token exchange succeeded; profile lookup threw an exception',
    });
    expect(attempts.filter((attempt) => attempt.phase === 'callback')).toHaveLength(1);
  });

  it('keeps overlapping callbacks separate on a reused auth instance', async () => {
    const forbidden = await start();
    const empty = await start();
    await Promise.all([complete(forbidden, 'forbidden'), complete(empty, 'empty')]);
    const details = attempts.filter((attempt) => attempt.phase === 'callback').map((attempt) => attempt.errorDescription);
    expect(details).toEqual(expect.arrayContaining([
      expect.stringContaining('HTTP 403'), expect.stringContaining('addresses=0'),
    ]));
    expect(details.some((detail) => detail?.includes('HTTP 403') && detail.includes('addresses=0'))).toBe(false);
  });
});

async function pending(code = 'forbidden', query?: string) {
  return cookieOf(await complete(await start(query), code));
}
async function send(cookie: string, email = 'work@example.test') {
  const response = await post('/github-email/send', { email }, cookie);
  expect(response.status).toBe(200);
  return /#token=([a-f0-9-]+)/.exec(mail.last!.text)![1]!;
}
async function authorizeQuery(email = 'work@example.test') {
  const admin = await post('/sign-up/email', { email: 'admin@example.test', name: 'Admin', password: 'admin-test-password' });
  db.prepare("UPDATE user SET role = 'admin', email_verified = 1 WHERE email = 'admin@example.test'").run();
  const client = await auth.api.adminCreateOAuthClient({ headers: new Headers({ cookie: cookieOf(admin) }), body: { client_name: 'Invite dashboard', redirect_uris: ['http://localhost:9999/cb'], application_type: 'native', skip_consent: true } }) as { client_id: string };
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('v'.repeat(43)));
  const challenge = Buffer.from(hash).toString('base64url');
  const query = new URLSearchParams({ client_id: client.client_id, response_type: 'code', redirect_uri: 'http://localhost:9999/cb', scope: 'openid profile email', state: 'dashboard-state', code_challenge: challenge, code_challenge_method: 'S256', login_hint: email });
  const response = await auth.handler(new Request(`${ORIGIN}/api/auth/oauth2/authorize?${query}`) as never);
  expect(response.status).toBe(302);
  return new URL(response.headers.get('location')!, ORIGIN).search.slice(1);
}

describe('verified GitHub email fallback', () => {
  it.each(['email-network-error', 'email-malformed', 'email-timeout'])('verifies a mailbox after an authenticated profile but unavailable email lookup: %s', async (code) => {
    const cookie = await pending(code);
    expect(db.prepare('SELECT COUNT(*) AS n FROM user').get()).toEqual({ n: 0 });
    const response = await post('/github-email/verify', { token: await send(cookie) }, cookie);
    expect(response.status).toBe(200);
    expect(db.prepare('SELECT email, email_verified FROM user').get()).toEqual({ email: 'work@example.test', email_verified: 1 });
    expect(db.prepare('SELECT provider_id, account_id FROM account').get()).toEqual({ provider_id: 'github', account_id: '12345' });
    const returning = await complete(await start(), code);
    expect(new URL(returning.headers.get('location')!, ORIGIN).pathname).toBe('/');
    expect(db.prepare('SELECT COUNT(*) AS n FROM user').get()).toEqual({ n: 1 });
  }, 10_000); // Timeout fixture exercises two callbacks and their bounded diagnostic reads.

  it('does not offer mailbox verification when GitHub rejects the profile credentials', async () => {
    const response = await complete(await start(), 'profile-unauthorized');
    expect(new URL(response.headers.get('location')!, ORIGIN).pathname).not.toBe('/github-email');
    expect(calls).toEqual(['/login/oauth/access_token', '/user']);
    expect(db.prepare("SELECT COUNT(*) AS n FROM verification WHERE identifier LIKE 'github-email:%'").get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM user').get()).toEqual({ n: 0 });
  });

  it.each(['originating application', 'another application', 'another application beyond the first page', 'issuer login'])('preserves organization SSO when changing a linked account email through %s', async (origin) => {
    await complete(await start(), 'success');
    db.prepare("UPDATE user SET email = 'staff@corp.test'").run();
    const before = db.prepare('SELECT id, email FROM user').get();
    const query = origin === 'issuer login' ? undefined : await authorizeQuery('personal@example.test');
    if (origin === 'issuer login') db.prepare("UPDATE user SET email_verified = 0 WHERE email = 'staff@corp.test'").run();
    const cookie = await pending('success', query);
    const token = await send(cookie, 'personal@example.test');
    // Apply a route after verification starts, using the real issuer registry.
    const routed: SignInPolicy = { providers: ['github'], password: false, domainRoutes: [{ domains: ['corp.test'], provider: 'microsoft' }] };
    if (origin === 'originating application') {
      policy = routed;
      db.prepare('UPDATE oauth_client SET metadata = ?').run(JSON.stringify({ signIn: routed }));
    } else {
      if (origin.includes('first page')) {
        const insert = db.prepare('INSERT INTO oauth_client (id, client_id, redirect_uris) VALUES (?, ?, ?)');
        db.transaction(() => { for (let i = 0; i < 100; i++) insert.run(`filler-${i}`, `filler-${i}`, '[]'); })();
      }
      db.prepare('INSERT INTO oauth_client (id, client_id, redirect_uris, metadata) VALUES (?, ?, ?, ?)').run('protected-client', 'protected-client', '[]', JSON.stringify({ signIn: routed }));
    }
    const response = await post('/github-email/verify', { token, ...(query ? { oauth_query: query } : {}) }, cookie);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining('required sign-in method') });
    expect(db.prepare("SELECT id, email FROM user WHERE email = 'staff@corp.test'").get()).toEqual(before);
    // The refusal does not burn the mailbox proof; removing the restriction permits retry.
    policy = undefined;
    db.prepare('UPDATE oauth_client SET disabled = 1').run();
    if (!query) expect((await post('/github-email/verify', { token }, cookie)).status).toBe(200);
  });

  it.each(['expired', 'permanent', 'future'])('handles a %s ban consistently with ordinary GitHub sign-in', async (ban) => {
    await complete(await start(), 'success');
    const query = await authorizeQuery();
    const cookie = await pending('success', query);
    const token = await send(cookie);
    db.prepare("UPDATE user SET banned = 1, ban_expires = ? WHERE email = 'private@example.test'").run(ban === 'permanent' ? null : Date.now() + (ban === 'expired' ? -60_000 : 60_000));
    const response = await post('/github-email/verify', { token, oauth_query: query }, cookie);
    expect(response.status).toBe(ban === 'expired' ? 200 : 403);
    if (ban === 'expired') {
      const { url } = await response.json() as { url: string };
      expect(new URL(url).searchParams.get('code')).toBeTruthy();
      expect(db.prepare("SELECT email, banned FROM user WHERE email = 'work@example.test'").get()).toEqual({ email: 'work@example.test', banned: 0 });
    } else {
      expect(db.prepare("SELECT email FROM user WHERE email = 'private@example.test'").get()).toBeTruthy();
      expect(db.prepare("SELECT COUNT(*) AS n FROM verification WHERE identifier LIKE 'github-email-proof:%'").get()).toEqual({ n: 1 });
    }
  });

  it('requires both browser proof and emailed proof, issues one GitHub session, and reuses its stable identity when emails remain unavailable', async () => {
    const cookie = await pending();
    const token = await send(cookie);
    expect(mail.last!.to).toEqual([{ email: 'work@example.test' }]);
    const preview = await post('/github-email/status', { token }, cookie);
    expect(await preview.json()).toMatchObject({ email: 'work@example.test', linking: false });
    expect(JSON.stringify(db.prepare('SELECT * FROM verification').all())).not.toContain(token);
    expect((await post('/github-email/verify', { token })).status).toBe(400);
    const other = await pending();
    expect((await post('/github-email/status', { token }, other)).status).toBe(400);
    expect((await post('/github-email/verify', { token }, other)).status).toBe(400);
    const responses = await Promise.all([post('/github-email/verify', { token }, cookie), post('/github-email/verify', { token }, cookie)]);
    const verified = responses.find((r) => r.status === 200)!;
    expect(verified).toBeDefined();
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    const user = db.prepare('SELECT id, email, email_verified FROM user').get() as { id: string };
    expect(user).toMatchObject({ email: 'work@example.test', email_verified: 1 });
    expect(db.prepare('SELECT user_id, provider_id, account_id FROM account').get()).toEqual({ user_id: user.id, provider_id: 'github', account_id: '12345' });
    expect(db.prepare('SELECT sign_in_provider FROM session').get()).toEqual({ sign_in_provider: 'github' });
    expect(attempts.filter((attempt) => attempt.outcome === 'succeeded')).toEqual([expect.objectContaining({ method: 'github', phase: 'callback', userId: user.id })]);
    expect((await post('/github-email/verify', { token }, cookie)).status).toBe(400);
    const returning = await complete(await start(), 'forbidden');
    expect(new URL(returning.headers.get('location')!, ORIGIN).pathname).toBe('/');
    expect(db.prepare('SELECT id FROM user').all()).toEqual([{ id: user.id }]);
  });

  it('catches a different GitHub email from the signed login hint and resumes the original OIDC request after verification', async () => {
    const query = await authorizeQuery();
    const cookie = await pending('success', query);
    const status = await auth.handler(new Request(`${ORIGIN}/api/auth/github-email/status`, { headers: { cookie } }) as never);
    expect(await status.json()).toMatchObject({ email: 'work@example.test', oauthQuery: query });
    const token = await send(cookie);
    expect((await post('/github-email/verify', { token }, cookie)).status).toBe(400);
    const response = await post('/github-email/verify', { token, oauth_query: query }, cookie);
    expect(response.status).toBe(200);
    const result = await response.json() as { url: string };
    expect(new URL(result.url).origin).toBe('http://localhost:9999');
    expect(new URL(result.url).searchParams.get('code')).toBeTruthy();
    expect(new URL(result.url).searchParams.get('state')).toBe('dashboard-state');
  });

  it('keeps the user id when verifying a new email for an already linked GitHub account and revokes previous issuer sessions', async () => {
    await complete(await start(), 'success');
    const before = db.prepare('SELECT id FROM user').get();
    const query = await authorizeQuery();
    const cookie = await pending('success', query);
    const response = await post('/github-email/verify', { token: await send(cookie), oauth_query: query }, cookie);
    expect(response.status).toBe(200);
    expect(db.prepare("SELECT id FROM user WHERE email = 'work@example.test'").get()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM session WHERE user_id = ?').get((before as { id: string }).id)).toEqual({ n: 1 });
  });

  it('does not let verification bypass the relying party’s provider policy', async () => {
    const query = await authorizeQuery();
    const cookie = await pending('empty', query);
    policy = { providers: ['microsoft'], password: false };
    const response = await post('/github-email/verify', { token: await send(cookie), oauth_query: query }, cookie);
    expect(response.status).toBe(200);
    const result = await response.json() as { url: string };
    expect(new URL(result.url, ORIGIN).pathname).toBe('/login');
    expect(result.url).not.toContain('code=');
  });

  it('refuses existing addresses at sending and rechecks if another account takes the address before verification', async () => {
    await post('/sign-up/email', { email: 'existing@example.test', name: 'Existing', password: 'existing-password' });
    const cookie = await pending();
    expect((await post('/github-email/send', { email: 'existing@example.test' }, cookie)).status).toBe(409);
    const token = await send(cookie);
    await post('/sign-up/email', { email: 'work@example.test', name: 'Other', password: 'other-password' });
    expect((await post('/github-email/verify', { token }, cookie)).status).toBe(409);
    expect(db.prepare("SELECT * FROM account WHERE provider_id = 'github'").all()).toHaveLength(0);
  });

  it('expires pending sign-ins and emailed secrets, rate limits resends, and invalidates bounced delivery', async () => {
    const cookie = await pending();
    mail.suppress('bounce@example.test');
    expect((await post('/github-email/send', { email: 'bounce@example.test' }, cookie)).status).toBe(503);
    expect(db.prepare("SELECT * FROM verification WHERE identifier LIKE 'github-email-proof:%'").all()).toHaveLength(0);
    expect((await post('/github-email/send', { email: 'work@example.test' }, cookie)).status).toBe(429);
    db.prepare("DELETE FROM verification WHERE identifier LIKE 'github-email-send:%'").run();
    const token = await send(cookie);
    db.prepare("UPDATE verification SET expires_at = 0 WHERE identifier LIKE 'github-email-proof:%'").run();
    expect((await post('/github-email/verify', { token }, cookie)).status).toBe(400);
    db.prepare("UPDATE verification SET expires_at = 0 WHERE identifier LIKE 'github-email:%'").run();
    expect((await post('/github-email/send', { email: 'work@example.test' }, cookie)).status).toBe(400);
    expect(db.prepare('SELECT * FROM user').all()).toHaveLength(0);
  });

  it('refuses disabled GitHub sign-up both at the callback and if disabled while verification was pending', async () => {
    const cookie = await pending();
    const token = await send(cookie);
    auth = fixtureAuth(true);
    expect((await post('/github-email/verify', { token }, cookie)).status).toBe(403);
    const callback = await complete(await start(), 'empty');
    expect(new URL(callback.headers.get('location')!, ORIGIN).pathname).not.toBe('/github-email');
    expect(db.prepare('SELECT * FROM user').all()).toHaveLength(0);
  });

  it('permits only one account when two browser flows verify different addresses for the same GitHub account', async () => {
    const one = await pending();
    const two = await pending();
    const first = await send(one);
    // Model the second email being sent in a later rate-limit window without a real wait.
    db.prepare("DELETE FROM verification WHERE identifier LIKE 'github-email-send:%'").run();
    const second = await send(two, 'other@example.test');
    const results = await Promise.all([post('/github-email/verify', { token: first }, one), post('/github-email/verify', { token: second }, two)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM account').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM user').get()).toEqual({ n: 1 });
  });

  it('can explicitly connect an email-less GitHub identity after an existing account signs in and proves its own email', async () => {
    const login = await post('/sign-up/email', { email: 'existing@example.test', name: 'Existing', password: 'existing-password' });
    const localCookie = cookieOf(login);
    const localUser = db.prepare('SELECT id FROM user').get();
    const linked = await post('/link-social', { provider: 'github', callbackURL: '/' }, localCookie);
    expect(linked.status).toBe(200);
    const { url } = await linked.json() as { url: string };
    const callback = await complete({ state: new URL(url).searchParams.get('state')!, cookie: `${localCookie}; ${cookieOf(linked)}` }, 'forbidden');
    const cookie = `${localCookie}; ${cookieOf(callback)}`;
    expect(new URL(callback.headers.get('location')!, ORIGIN).pathname).toBe('/github-email');
    expect((await post('/github-email/send', { email: 'different@example.test' }, cookie)).status).toBe(403);
    const token = await send(cookie, 'existing@example.test');
    expect((await post('/github-email/verify', { token }, cookieOf(callback))).status).toBe(403);
    const verified = await post('/github-email/verify', { token }, cookie);
    expect(verified.status).toBe(200);
    expect(db.prepare('SELECT id FROM user').get()).toEqual(localUser);
    expect(db.prepare('SELECT provider_id FROM account ORDER BY provider_id').all()).toEqual([{ provider_id: 'credential' }, { provider_id: 'github' }]);
    expect(db.prepare('SELECT email_verified FROM user').get()).toEqual({ email_verified: 1 });
  });
});
