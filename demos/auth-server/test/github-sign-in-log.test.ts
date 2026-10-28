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

const ORIGIN = 'http://localhost:8877';
const handler = createRequire(import.meta.url)('../postman/mocks/github/handler.cjs') as RequestListener;
const server = createServer(handler);
let upstream: string;
let db: Database.Database;
let auth: Auth;
let attempts: SignInAttemptInput[];
let calls: string[];
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
  auth = buildAuth({
    database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
    secret: 'test-secret-000000000000000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: new MockEmailTransport(),
    sender: { email: 'no-reply@example.test' },
    socialProviders: { github: { clientId: 'fixture-client', clientSecret: 'fixture-client-secret' } },
    recordSignIn: (attempt) => { attempts.push(attempt); },
    fetchSignInDiagnostic: (input, init) => globalThis.fetch(input, init),
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  db.close();
});

async function start() {
  const response = await auth.handler(new Request(`${ORIGIN}/api/auth/sign-in/social`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'github', callbackURL: '/', errorCallbackURL: '/?social_error=1' }),
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
    expect(new URL(response.headers.get('location')!, ORIGIN).searchParams.get('error')).toBe('email_not_found');
    expect(attempts.at(-1)).toMatchObject({ outcome: 'failed', phase: 'callback', error: 'email_not_found' });
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
