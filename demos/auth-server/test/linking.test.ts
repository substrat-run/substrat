import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';
import {
  genericProvidersFrom,
  readProviders,
  socialProvidersFrom,
  trustedProvidersFrom,
} from '../src/providers.js';
import type { SqlExec } from '../src/introspect.js';

/**
 * ACCOUNT LINKING — one person, one account, several ways in.
 *
 * The wall this is about: someone with an account here clicks "Continue with <provider>", the
 * upstream hands over an address that already belongs to that account, and Better Auth refuses
 * with `account not linked` rather than handing the account over. That refusal is correct — an
 * address at an upstream is not by itself permission to become whoever holds it here — and it
 * has exactly two ways past, which is what this file pins:
 *
 *   - an ADMINISTRATOR trusts the provider (`trust_email`, the panel's toggle), and the join
 *     happens at sign-in — but ONLY when the local row is email-verified too, which is Better
 *     Auth's own gate against pre-registering at someone else's address. An account an
 *     administrator created, or one BankID minted, is not, so trusting the provider is not by
 *     itself enough and the second test here says so;
 *   - the PERSON connects it from inside a session that already proves who they are
 *     (`/link-social`). That path asks nothing of the local row — the session already
 *     answered the question the verified address was standing in for — so it is the one that
 *     works for an unverified account, and it is what the dashboard now offers.
 *
 * The property that makes either worth having is the last test: after the link, signing in
 * through the upstream returns the SAME user id. That id is the `sub` every relying party
 * stores, so "linked" has to mean the account was kept — not that a second one now exists
 * with the same address on it.
 */

const ORIGIN = 'http://localhost:8877';
const ADMIN = { email: 'admin@auth.test', password: 'admin-demo-pass', name: 'Demo Admin' };

/** The stubbed upstream: a custom (generic OIDC) provider, saved the way the panel saves one. */
const ACME_DISCOVERY = {
  issuer: 'https://id.acme.test',
  authorization_endpoint: 'https://id.acme.test/oauth/authorize',
  token_endpoint: 'https://id.acme.test/oauth/token',
  userinfo_endpoint: 'https://id.acme.test/oauth/userinfo',
  jwks_uri: 'https://id.acme.test/.well-known/jwks.json',
};

/**
 * What the upstream says about the person coming back. `email_verified` matters on BOTH paths
 * — an untrusted provider that does not publish the claim (Entra does not) is refused whether
 * the person is signing in or linking from inside a session — so it is true here, and what
 * the tests vary is the LOCAL account, which is where the two paths actually differ.
 */
let upstreamProfile: Record<string, unknown>;

let db: Database.Database;
let sql: SqlExec;
let auth: Auth;
let adminId: string;
/** The operator's `ACCOUNT_LINKING` decision, as both runtimes resolve it before `buildAuth`. */
let autoLinkAccounts: boolean;

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

/** Every cookie a response set, as a request header — the OAuth state cookie included, which
 *  the callback checks against the state it was handed. */
const cookiesOf = (res: Response): string[] =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .filter((pair) => !pair.endsWith('='));

const signInAs = async (who: { email: string; password: string }): Promise<string> => {
  const res = await call('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(who),
  });
  expect(res.status).toBe(200);
  return cookiesOf(res).join('; ');
};

/** Better Auth over the CURRENT provider rows — rebuilt per request, as both runtimes do. */
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
    autoLinkAccounts,
  });
}

/** Save the upstream as a row, exactly as the providers panel does (discovery at save time). */
function saveAcme(over: { trust_email?: 0 | 1 } = {}): void {
  db.prepare(
    `INSERT INTO identity_provider
       (provider_id, client_id, client_secret, tenant_id, issuer, label, endpoints, allow_signup, trust_email, disabled, updated_at)
     VALUES ('acme', 'acme-client-id', 'acme-secret', NULL, ?, 'Acme SSO', ?, 1, ?, 0, 1)
     ON CONFLICT(provider_id) DO UPDATE SET trust_email = excluded.trust_email`,
  ).run(ACME_DISCOVERY.issuer, JSON.stringify(ACME_DISCOVERY), over.trust_email ?? 0);
  auth = rebuild();
}

/** Start a redirect flow and come back through the callback with it, carrying its cookies. */
async function roundTrip(path: string, body: Record<string, unknown>, cookie?: string): Promise<Response> {
  const started = await call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  expect(started.status).toBe(200);
  const { url } = (await started.json()) as { url: string };
  const state = new URL(url).searchParams.get('state');
  expect(state).toBeTruthy();
  const carried = [...(cookie ? [cookie] : []), ...cookiesOf(started)].join('; ');
  return call(`/api/auth/callback/acme?code=an-authorization-code&state=${state}`, {
    headers: { cookie: carried },
  });
}

const accountsOf = (userId: string): { provider_id: string; account_id: string }[] =>
  db.prepare('SELECT provider_id, account_id FROM account WHERE user_id = ? ORDER BY provider_id').all(userId) as {
    provider_id: string;
    account_id: string;
  }[];

/** Put the local account in the state admin-created and BankID-minted accounts are in: an
 *  address nobody has proved. It is the half of the implicit-link gate that trusting a
 *  provider cannot cover. */
const unverify = (): void => {
  db.prepare('UPDATE user SET email_verified = 0 WHERE id = ?').run(adminId);
};

const userCount = (): number => (db.prepare('SELECT count(*) AS n FROM user').get() as { n: number }).n;

/** The upstream, stubbed: discovery (read once, at save time), the token exchange, and the
 *  userinfo read the generic provider makes when no id_token comes back. */
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target === 'https://id.acme.test/.well-known/openid-configuration') return Response.json(ACME_DISCOVERY);
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
  // A password account with a VERIFIED address, as `setupFirstAdmin` leaves the bootstrap
  // administrator. `unverify()` below puts it in the other state — the one an administrator
  // creating a user, or BankID minting one, actually produces.
  const created = await auth.api.signUpEmail({ body: ADMIN });
  adminId = created.user.id;
  db.prepare("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?").run(adminId);
  // `link` — the default, and what this issuer did before the key existed. The block below
  // is where the other mode is exercised.
  autoLinkAccounts = true;
  upstreamProfile = {
    sub: 'acme-subject-1',
    email: ADMIN.email,
    email_verified: true,
    name: ADMIN.name,
  };
});

describe('signing in with a provider that is not a method on the account yet', () => {
  it('refuses rather than claiming the account, and creates nothing', async () => {
    saveAcme();
    unverify();

    const res = await roundTrip('/api/auth/sign-in/social', {
      provider: 'acme',
      callbackURL: '/',
      errorCallbackURL: '/?social_error=1',
    });

    expect(res.status).toBe(302);
    const back = new URL(res.headers.get('location')!, ORIGIN);
    expect(back.pathname).toBe('/');
    expect(back.searchParams.get('social_error')).toBe('1');
    // The code the SPA translates into the message that now names the way out.
    expect(back.searchParams.get('error')).toBe('account_not_linked');
    // Nothing partial survived the refusal: no second account with this address, and the
    // upstream is not a sign-in method for the existing one either.
    expect(userCount()).toBe(1);
    expect(accountsOf(adminId).map((a) => a.provider_id)).toEqual(['credential']);
  });

  it('still refuses a TRUSTED provider while the local address is unverified', async () => {
    // The trap in the panel's toggle, and the reason the refusal message names two conditions
    // rather than one: `requireLocalEmailVerified` is Better Auth's, defaults on, and no
    // amount of trusting a directory answers it. An operator who trusts the provider and
    // watches the same refusal come back is not looking at a broken toggle.
    saveAcme({ trust_email: 1 });
    unverify();

    const res = await roundTrip('/api/auth/sign-in/social', {
      provider: 'acme',
      callbackURL: '/',
      errorCallbackURL: '/?social_error=1',
    });

    expect(new URL(res.headers.get('location')!, ORIGIN).searchParams.get('error')).toBe('account_not_linked');
    expect(accountsOf(adminId).map((a) => a.provider_id)).toEqual(['credential']);
  });

  it('joins them when the provider is trusted and the local address is verified', async () => {
    saveAcme({ trust_email: 1 });

    const res = await roundTrip('/api/auth/sign-in/social', { provider: 'acme', callbackURL: '/' });

    expect(res.status).toBe(302);
    expect(userCount()).toBe(1);
    expect(accountsOf(adminId).map((a) => a.provider_id)).toEqual(['acme', 'credential']);
  });
});

describe('the operator\u2019s linking mode (`ACCOUNT_LINKING`)', () => {
  it('refuses under `block` the exact join `link` would have made', async () => {
    // Everything the permissive mode needs is true here: the provider is trusted, the upstream
    // vouches for the address, and the local account is verified. The third test above proves
    // this same state links. The ONLY difference is the operator's decision.
    autoLinkAccounts = false;
    saveAcme({ trust_email: 1 });

    const res = await roundTrip('/api/auth/sign-in/social', {
      provider: 'acme',
      callbackURL: '/',
      errorCallbackURL: '/?social_error=1',
    });

    expect(new URL(res.headers.get('location')!, ORIGIN).searchParams.get('error')).toBe('account_not_linked');
    expect(userCount()).toBe(1);
    expect(accountsOf(adminId).map((a) => a.provider_id)).toEqual(['credential']);
  });

  it('does NOT take away the deliberate connect — that is the whole point of blocking', async () => {
    // `block` removes the join nobody asked for, not the one the person asks for from inside a
    // session that already proves the account. Taking both away would leave an issuer where a
    // second sign-in method simply cannot be added, and the refusal message the login screen
    // shows — "sign in the way you did before and connect it" — would be a lie.
    autoLinkAccounts = false;
    saveAcme();
    const cookie = await signInAs(ADMIN);

    const res = await roundTrip('/api/auth/link-social', { provider: 'acme', callbackURL: '/' }, cookie);

    expect(res.status).toBe(302);
    expect(userCount()).toBe(1);
    expect(accountsOf(adminId).map((a) => a.provider_id)).toEqual(['acme', 'credential']);
  });

  it('leaves an upstream that is nobody\u2019s account alone — blocking is about the join, not sign-in', async () => {
    // A new person arriving through the upstream has no local account to be joined TO, so the
    // mode has nothing to say about them. Reading `block` as "no federated sign-in" would turn
    // a linking policy into an outage for everyone the directory has not met yet.
    autoLinkAccounts = false;
    saveAcme();
    upstreamProfile = { ...upstreamProfile, sub: 'acme-subject-2', email: 'newcomer@auth.test' };

    const res = await roundTrip('/api/auth/sign-in/social', { provider: 'acme', callbackURL: '/' });

    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!, ORIGIN).searchParams.get('error')).toBeNull();
    expect(userCount()).toBe(2);
  });
});

describe('connecting a provider from inside a session', () => {
  it('attaches it to the account already signed in, unverified local address and all', async () => {
    // Exactly the state the two tests above refuse, and the same untrusted provider. The
    // session is what changes the question: nobody is being asked to accept an address as
    // proof of who this is, because the person is already signed in as them.
    saveAcme();
    unverify();
    const cookie = await signInAs(ADMIN);

    const res = await roundTrip(
      '/api/auth/link-social',
      { provider: 'acme', callbackURL: '/account', errorCallbackURL: '/account?link_error=1' },
      cookie,
    );

    expect(res.status).toBe(302);
    // `/account` is the console screen that shows the sign-in methods, and it is what
    // `connectProvider` asks for — `/` is not a screen once the console routes.
    expect(new URL(res.headers.get('location')!, ORIGIN).pathname).toBe('/account');
    // One account, two ways in — the point of the whole feature.
    expect(userCount()).toBe(1);
    expect(accountsOf(adminId)).toEqual([
      { provider_id: 'acme', account_id: 'acme-subject-1' },
      { provider_id: 'credential', account_id: adminId },
    ]);
  });

  it('lists both ways in, which is what the account screen reads', async () => {
    saveAcme();
    const cookie = await signInAs(ADMIN);
    await roundTrip('/api/auth/link-social', { provider: 'acme', callbackURL: '/account' }, cookie);

    const res = await call('/api/auth/list-accounts', { headers: { cookie } });
    expect(res.status).toBe(200);
    const accounts = (await res.json()) as { id: string; providerId: string }[];
    expect(accounts.map((a) => a.providerId).sort()).toEqual(['acme', 'credential']);

    // …and disconnecting one leaves the other. (The library refuses to remove the last one;
    // the screen disables the button rather than letting someone find that out by pressing it.)
    const acme = accounts.find((a) => a.providerId === 'acme')!;
    const unlinked = await call('/api/auth/unlink-account', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ accountId: acme.id }),
    });
    expect(unlinked.status).toBe(200);
    expect(accountsOf(adminId).map((a) => a.provider_id)).toEqual(['credential']);
  });

  it('refuses an upstream account whose address is someone else\u2019s', async () => {
    saveAcme();
    const cookie = await signInAs(ADMIN);
    upstreamProfile = { ...upstreamProfile, email: 'someone.else@auth.test' };

    const res = await roundTrip(
      '/api/auth/link-social',
      { provider: 'acme', callbackURL: '/account', errorCallbackURL: '/account?link_error=1' },
      cookie,
    );

    expect(res.status).toBe(302);
    const back = new URL(res.headers.get('location')!, ORIGIN);
    // The marker is worth nothing on a path that does not read it: `link_error` is read by
    // the account screen, so a refusal has to come back to the account screen.
    expect(back.pathname).toBe('/account');
    expect(back.searchParams.get('link_error')).toBe('1');
    expect(back.searchParams.get('error')).toBe('email_does_not_match');
    expect(accountsOf(adminId).map((a) => a.provider_id)).toEqual(['credential']);
  });

  it('makes the next sign-in through that provider the SAME person', async () => {
    saveAcme();
    unverify();
    const cookie = await signInAs(ADMIN);
    await roundTrip('/api/auth/link-social', { provider: 'acme', callbackURL: '/account' }, cookie);

    // Signed out, through the front door, with the provider still untrusted and the local
    // address still unverified — none of that is consulted any more, because the upstream
    // account is now a known way into this one.
    const res = await roundTrip('/api/auth/sign-in/social', { provider: 'acme', callbackURL: '/' });
    expect(res.status).toBe(302);

    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookiesOf(res).join('; ') }) as never,
    });
    // The id every relying party stored as `sub`, unchanged.
    expect(session?.user.id).toBe(adminId);
    expect(userCount()).toBe(1);
  });
});
