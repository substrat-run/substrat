import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport, type EmailMessage, type EmailTransport, type SendResult } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';
import { genericProvidersFrom, readProviders, socialProvidersFrom, trustedProvidersFrom } from '../src/providers.js';
import type { SqlExec } from '../src/introspect.js';

/**
 * A BRAND-NEW person's first federated sign-in, and what it is allowed to wait for.
 *
 * This is the asymmetry behind "sign-in works, except for people who have never signed in
 * before" — a report that sounds arbitrary and is not. One thing happens on a first sign-in and
 * never again:
 *
 *   `handleOAuthUserInfo` → `isRegister && !user.emailVerified && sendOnSignUp`
 *                         → `dispatchVerificationEmail`
 *                         → `runInBackgroundOrAwait(send)`  ← `else await promise`
 *
 * Both conditions hold here permanently. `sendOnSignUp` is on (`buildAuth`), and Entra does not
 * publish `email_verified`, which Better Auth maps to `false` — so a new Microsoft user is
 * created unverified and gets the mail. Without an `advanced.backgroundTasks.handler` that send
 * is AWAITED inside `/callback/:id`, which has not answered yet: the browser is mid-redirect,
 * looking at a page that is still loading, while the platform mail relay — the control plane,
 * and then its own mail provider — decides how long it takes. A returning user skips all of it.
 *
 * So the first test hands the transport a promise that NEVER RESOLVES. That is the shape of the
 * production failure, and it is the only way to assert the property rather than the timing: if
 * the callback waits on the mail at all, the test cannot finish.
 */

const ORIGIN = 'http://localhost:8877';
const EXISTING = { email: 'admin@auth.test', password: 'admin-demo-pass', name: 'Demo Admin' };

const ACME_DISCOVERY = {
  issuer: 'https://id.acme.test',
  authorization_endpoint: 'https://id.acme.test/oauth/authorize',
  token_endpoint: 'https://id.acme.test/oauth/token',
  userinfo_endpoint: 'https://id.acme.test/oauth/userinfo',
};

/** Someone this issuer has never seen, vouched for by an upstream that publishes no
 *  `email_verified` — which is Entra's actual behaviour, and what makes the mail fire. */
const NEWCOMER = { sub: 'acme-newcomer', email: 'newcomer@example.test', name: 'A Newcomer' };

/** A transport whose send never settles — the hanging relay, as a two-line class. */
class HangingTransport implements EmailTransport {
  attempts = 0;
  send(): Promise<SendResult> {
    this.attempts += 1;
    return new Promise<SendResult>(() => {
      /* deliberately never resolves */
    });
  }
}

let db: Database.Database;
let sql: SqlExec;
let auth: Auth;
/** What `runInBackground` was handed, so a test can await the work it deferred. */
let deferred: Promise<unknown>[];

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

/** Better Auth over the dev-shaped config, with the two things under test made explicit. */
function build(opts: { transport: EmailTransport; background: boolean }): Auth {
  const rows = readProviders(sql);
  return buildAuth({
    database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
    secret: 'test-secret-000000000000000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: opts.transport,
    sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    allowSignup: true,
    socialProviders: socialProvidersFrom(rows),
    genericProviders: genericProvidersFrom(rows),
    trustedProviders: trustedProvidersFrom(rows),
    autoLinkAccounts: true,
    ...(opts.background
      ? {
          runInBackground: (promise: Promise<unknown>) => {
            deferred.push(promise);
          },
        }
      : {}),
  });
}

function saveAcme(over: { trust_email?: 0 | 1 } = {}): void {
  db.prepare(
    `INSERT INTO identity_provider
       (provider_id, client_id, client_secret, tenant_id, issuer, label, endpoints, allow_signup, trust_email, disabled, updated_at)
     VALUES ('acme', 'acme-client-id', 'acme-secret', NULL, ?, 'Acme SSO', ?, 1, ?, 0, 1)
     ON CONFLICT(provider_id) DO UPDATE SET trust_email = excluded.trust_email`,
  ).run(ACME_DISCOVERY.issuer, JSON.stringify(ACME_DISCOVERY), over.trust_email ?? 0);
}

/** Where the callback's redirect went, and whether it carried a refusal — the difference
 *  between "the sign-in completed" and "it was refused and happened to send no mail". */
function outcomeOf(res: Response): { location: string; error: string | null } {
  const location = res.headers.get('location') ?? '';
  return {
    location,
    error: new URL(location, 'http://authority.invalid').searchParams.get('error'),
  };
}

/** The whole round trip: press the button, come back through the callback with the state. */
async function signInThrough(): Promise<Response> {
  const started = await call('/api/auth/sign-in/social', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'acme', callbackURL: '/', errorCallbackURL: '/?social_error=1' }),
  });
  expect(started.status).toBe(200);
  const { url } = (await started.json()) as { url: string };
  const state = new URL(url).searchParams.get('state');
  return call(`/api/auth/callback/acme?code=an-authorization-code&state=${state}`, {
    headers: { cookie: cookiesOf(started).join('; ') },
  });
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target === ACME_DISCOVERY.token_endpoint) {
      return Response.json({ access_token: 'an-upstream-access-token', token_type: 'Bearer', expires_in: 3600 });
    }
    // No `email_verified` — Entra does not publish it, and that absence is what makes Better
    // Auth create the account unverified and send the mail this file is about.
    if (target === ACME_DISCOVERY.userinfo_endpoint) return Response.json(NEWCOMER);
    return realFetch(input as never, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  sql = sqlExecOf(db);
  deferred = [];
  saveAcme();
});

describe("a new person's first sign-in", () => {
  it('finishes even when the mail relay never answers', async () => {
    const hanging = new HangingTransport();
    auth = build({ transport: hanging, background: true });

    // If the verification email is awaited, this await never returns and the test times out —
    // which is precisely what the browser was doing.
    const res = await signInThrough();

    expect(res.status).toBe(302);
    // And it SUCCEEDED rather than being refused on the way past — otherwise "it finished" would
    // be true of a sign-in that did not happen.
    expect(outcomeOf(res).error).toBeNull();
    // It really did try, and it really was deferred: the property is "not in the critical
    // path", not "not sent".
    expect(hanging.attempts).toBe(1);
    expect(deferred).toHaveLength(1);
    // And the account exists — the sign-in completed, rather than being rolled back with it.
    expect(db.prepare('SELECT count(*) AS n FROM user WHERE email = ?').get(NEWCOMER.email)).toEqual({ n: 1 });
  });

  it('still sends the mail — deferred, not dropped', async () => {
    const mock = new MockEmailTransport();
    auth = build({ transport: mock, background: true });

    await signInThrough();
    // Nothing has been awaited yet, so the send is still outstanding: that IS the deferral.
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);

    expect(mock.sent).toHaveLength(1);
    expect(mock.last?.to[0]?.email).toBe(NEWCOMER.email);
  });

  it('is not deferred when no handler is configured, which is what keeps the suite deterministic', async () => {
    const mock = new MockEmailTransport();
    auth = build({ transport: mock, background: false });

    await signInThrough();

    // Already sent by the time the callback answered — the inline default, relied on by every
    // other test here that asserts on a message without awaiting anything.
    expect(mock.sent).toHaveLength(1);
    expect(deferred).toHaveLength(0);
  });
});

describe('a returning person', () => {
  it('never pays for it — the reason this looked arbitrary from outside', async () => {
    // Trusted, so the upstream's address is accepted as proof and the join actually happens.
    // Without this the sign-in is REFUSED (`account_not_linked`) and sends no mail either — a
    // green test that would stay green if the mechanism broke, which is why the redirect is
    // asserted to carry no error rather than merely to be a 302.
    saveAcme({ trust_email: 1 });
    const mock = new MockEmailTransport();
    auth = build({ transport: mock, background: false });
    const created = await auth.api.signUpEmail({
      body: { email: NEWCOMER.email, password: EXISTING.password, name: NEWCOMER.name },
    });
    db.prepare('UPDATE user SET email_verified = 1 WHERE id = ?').run(created.user.id);
    const onSignUp = mock.sent.length;

    const res = await signInThrough();

    expect(res.status).toBe(302);
    // The sign-in SUCCEEDED — this is the clause that makes the assertion below mean something.
    expect(outcomeOf(res).error).toBeNull();
    // And it is the same account, not a second one: a returning person, by definition.
    expect(db.prepare('SELECT count(*) AS n FROM user').get()).toEqual({ n: 1 });
    // No registration, so no verification mail, so nothing in the redirect's way.
    expect(mock.sent).toHaveLength(onSignUp);
  });
});
