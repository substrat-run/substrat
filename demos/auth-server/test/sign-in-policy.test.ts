import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';
import { createAdminApi } from '../src/admin-api.js';
import {
  assertSignInPolicy,
  clientSignIn,
  effectiveSignIn,
  policyAdmits,
  readSignInPolicy,
  sanitizeSignInPolicy,
  signInMethodOfPath,
} from '../src/sign-in-policy.js';
import type { SqlExec } from '../src/introspect.js';
import type { SessionSubject } from '../src/do-contract.js';

/**
 * Per-client sign-in policy (`src/sign-in-policy.ts`) — "this application accepts Microsoft
 * and nothing else", said per relying party.
 *
 * The suite is split the way the feature is, because the halves make different promises:
 *
 *  1. **The policy is ENFORCED, not drawn.** A session established a way the client does not
 *     accept must not become an authorization code for it — however it was made, and whether
 *     it arrives at `/oauth2/authorize` by navigation or by a sign-in resuming one. These
 *     cases drive the REAL plugin, because the guarantee is entirely about what
 *     `oauthProvider` does with the request afterwards; a mock of it would assert our own
 *     opinion back at us.
 *  2. **The stamp is what makes the check possible.** `account` records which providers a
 *     user has ever linked; only `session.sign_in_provider` records the one they used just
 *     now, and it is written by the same `buildAuth` config both runtimes share.
 *
 * The pure functions are pinned separately, most of all the ones whose failure is silent: an
 * unstamped session admitted, or a policy that permits nothing being stored rather than
 * refused.
 */

const ORIGIN = 'http://localhost:8877';
const ADMIN = { email: 'admin@auth.test', password: 'admin-demo-pass', name: 'Demo Admin' };
const RP_REDIRECT = 'http://localhost:9999/cb';

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

function call(path: string, init?: RequestInit): Promise<Response> {
  return auth.handler(new Request(`${ORIGIN}${path}`, init) as never);
}

/** A top-level browser navigation (the plugin answers these with a 302). */
const NAVIGATE = { 'sec-fetch-mode': 'navigate' } as const;
/** What the SPA's `authClient` sends: an ordinary same-origin `fetch`. */
const FROM_FETCH = { 'content-type': 'application/json', 'sec-fetch-mode': 'cors' } as const;

function cookiesFrom(...responses: Response[]): string {
  return responses
    .flatMap((res) => res.headers.getSetCookie())
    .map((c) => c.split(';')[0] ?? '')
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

async function signInAs(who: { email: string; password: string }): Promise<string> {
  const res = await call('/api/auth/sign-in/email', {
    method: 'POST',
    headers: FROM_FETCH,
    body: JSON.stringify(who),
  });
  expect(res.status).toBe(200);
  return cookiesFrom(res);
}

/** Register a client through the dashboard's own path, with its policy riding along. */
async function register(name: string, cookie: string, metadata?: Record<string, unknown>): Promise<string> {
  const res = await api.request('http://localhost/clients', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [RP_REDIRECT],
      application_type: 'native',
      ...(metadata ? { metadata } : {}),
    }),
  });
  expect(res.status).toBeLessThan(300);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function pkceChallenge(): Promise<string> {
  const base64url = (bytes: ArrayBuffer): string =>
    btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  return base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

async function authorize(clientId: string, cookie: string, extra: Record<string, string> = {}): Promise<Response> {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: RP_REDIRECT,
    scope: 'openid profile',
    state: 'st',
    code_challenge: await pkceChallenge(),
    code_challenge_method: 'S256',
    ...extra,
  });
  return call(`/api/auth/oauth2/authorize?${q.toString()}`, { headers: { ...NAVIGATE, cookie } });
}

/** Where a 302 went — the path alone, which is the thing each case is about. */
function landedOn(res: Response): string {
  expect(res.status).toBe(302);
  const location = res.headers.get('location') ?? '';
  return location.split('?')[0] ?? '';
}

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
    // The wiring both runtimes do (`auth-do.ts`, `server.ts`): the policy is read from the
    // registry per request, so a client narrowed a moment ago decides the next authorize.
    signInPolicyFor: (clientId) => readSignInPolicy(sql, clientId),
  });
  const created = await auth.api.signUpEmail({ body: ADMIN });
  db.prepare("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?").run(created.user.id);
  const session = (headers: Headers): Promise<SessionSubject | null> =>
    auth.api.getSession({ headers: headers as never }).then((s) => {
      const u = s?.user as { id: string; email?: string; name?: string; role?: string } | undefined;
      return u ? { sub: u.id, email: u.email ?? null, name: u.name ?? null, role: u.role ?? null } : null;
    });
  api = createAdminApi({ sql, session, effectiveCfg: () => ({}), auth: () => auth.api as never });
});

describe('the session records HOW it was established', () => {
  it('stamps a password sign-in — and a sign-UP, which mints one too', async () => {
    await signInAs(ADMIN);
    const rows = db.prepare('SELECT sign_in_provider FROM session ORDER BY created_at').all() as {
      sign_in_provider: string | null;
    }[];
    // Two sessions: the admin's `signUpEmail` in `beforeEach` (which signs in on success) and
    // the sign-in just now. Both are password sign-ins, and BOTH are stamped — a sign-up that
    // left its session unstamped would fail closed at the first restricted client someone was
    // sent to straight after creating their account.
    expect(rows.map((r) => r.sign_in_provider)).toEqual(['password', 'password']);
  });

  it('names every path a session can be minted on, and nothing else', () => {
    expect(signInMethodOfPath('/sign-in/email')).toBe('password');
    expect(signInMethodOfPath('/sign-up/email')).toBe('password');
    // Every upstream at once: catalogue providers and `genericOAuth` ones share this route.
    expect(signInMethodOfPath('/callback/microsoft')).toBe('microsoft');
    expect(signInMethodOfPath('/callback/keycloak-eu')).toBe('keycloak-eu');
    expect(signInMethodOfPath('/oauth2/callback/okta')).toBe('okta');
    expect(signInMethodOfPath('/bankid/collect')).toBe('bankid');
    expect(signInMethodOfPath('/supabase/session')).toBe('supabase');
    // Not a sign-in, and — the one that matters — an administrator's impersonation. Unknown
    // stamps null, and a null is refused by every policy rather than admitted by default.
    expect(signInMethodOfPath('/bankid/start')).toBe(null);
    expect(signInMethodOfPath('/admin/impersonate-user')).toBe(null);
    expect(signInMethodOfPath(undefined)).toBe(null);
  });

  it('refuses to read a stamp the callback path is not entitled to', () => {
    // `admin-api.ts` will not register an upstream under either of these ids, but a row
    // written before that check existed still can be — and reading its callback back as
    // `password` would hand a whole upstream directory to a password-only client. So the
    // read is fail-closed too: an unstamped session, refused under every policy.
    expect(signInMethodOfPath('/callback/password')).toBe(null);
    expect(signInMethodOfPath('/oauth2/callback/password')).toBe(null);
    expect(signInMethodOfPath('/callback/bankid')).toBe(null);
    // `supabase` is not in that list on purpose: `/supabase/session` stamps the id of a real
    // catalogue provider because those sessions ARE that upstream's.
    expect(signInMethodOfPath('/callback/supabase')).toBe('supabase');
  });
});

describe('a restricted client refuses a session established another way', () => {
  it('sends it back to sign in, while an unrestricted client is handed straight on', async () => {
    const cookie = await signInAs(ADMIN);
    const open = await register('Open RP', cookie);
    const microsoftOnly = await register('Directory RP', cookie, {
      signIn: { providers: ['microsoft'], password: false },
    });

    // The control, and it is the whole point of having one: this session, this issuer, this
    // moment — the only difference is the client's policy.
    expect(landedOn(await authorize(open, cookie))).toBe('/consent');
    expect(landedOn(await authorize(microsoftOnly, cookie))).toBe('/login');
  });

  it('checks the RESUME too — the path a filtered login screen cannot cover', async () => {
    const cookie = await signInAs(ADMIN);
    const microsoftOnly = await register('Directory RP', cookie, {
      signIn: { providers: ['microsoft'], password: false },
    });
    const parked = await authorize(microsoftOnly, cookie);
    const oauthQuery = (parked.headers.get('location') ?? '').split('?')[1] ?? '';
    expect(oauthQuery).toContain('sig=');

    // Sign in with a password, handing the pending request back exactly as the SPA does. The
    // screen would never have offered this button — but `POST /sign-in/email` does not need a
    // screen, which is why the drawing is not the policy.
    const signIn = await call('/api/auth/sign-in/email', {
      method: 'POST',
      headers: FROM_FETCH,
      body: JSON.stringify({ ...ADMIN, oauth_query: oauthQuery }),
    });
    expect(signIn.status).toBe(200);
    const body = (await signIn.json()) as { redirect?: boolean; url?: string };
    // A session was made — that part is not refused, and must not be: this person may well
    // sign into the console. What they do not get is a code for THIS client.
    expect(body.url?.startsWith('/consent')).toBe(false);
    expect(body.url?.startsWith('/login')).toBe(true);
  });

  it('admits the session once it was established a way the client accepts', async () => {
    const cookie = await signInAs(ADMIN);
    const passwordOnly = await register('Password RP', cookie, {
      signIn: { providers: [], password: true },
    });
    expect(landedOn(await authorize(passwordOnly, cookie))).toBe('/consent');
  });

  it('answers a silent (`prompt=none`) request with login_required, not a code', async () => {
    const cookie = await signInAs(ADMIN);
    const microsoftOnly = await register('Silent RP', cookie, {
      signIn: { providers: ['microsoft'], password: false },
    });
    const res = await authorize(microsoftOnly, cookie, { prompt: 'none' });

    // The relying party asked not to interact, so it gets the spec's answer at its own
    // callback rather than a login page in a hidden frame it cannot show.
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(RP_REDIRECT);
    expect(location.searchParams.get('error')).toBe('login_required');
    expect(location.searchParams.get('code')).toBe(null);
  });

  it('refuses a session that predates the stamp', async () => {
    const cookie = await signInAs(ADMIN);
    const microsoftOnly = await register('Directory RP', cookie, {
      signIn: { providers: ['microsoft'], password: false },
    });
    // What an install upgraded into this feature actually holds: live sessions with no
    // recorded method. Fail-closed costs those people one sign-in; admitting them would make
    // the restriction advisory for as long as the longest session lives.
    db.prepare('UPDATE session SET sign_in_provider = NULL').run();
    expect(landedOn(await authorize(microsoftOnly, cookie))).toBe('/login');
  });

  it('lets a password session through a client with no policy at all', async () => {
    const cookie = await signInAs(ADMIN);
    const unpoliced = await register('Plain RP', cookie, { plan: 'internal' });
    db.prepare('UPDATE session SET sign_in_provider = NULL').run();
    // No policy, so nothing to fail closed about — an unstamped session is only a problem
    // for a client that asked for something specific.
    expect(landedOn(await authorize(unpoliced, cookie))).toBe('/consent');
  });
});

describe('what the login screen is told', () => {
  const OFFERED = [
    { id: 'microsoft', label: 'Microsoft' },
    { id: 'google', label: 'Google' },
  ];

  it('narrows to the client policy, and says the narrowing was deliberate', async () => {
    const cookie = await signInAs(ADMIN);
    const clientId = await register('Directory RP', cookie, {
      signIn: { providers: ['microsoft'], password: false },
    });
    expect(clientSignIn(sql, clientId, OFFERED)).toEqual({
      providers: [{ id: 'microsoft', label: 'Microsoft' }],
      password: false,
      restricted: true,
    });
  });

  it('offers everything for an unknown, an unpoliced and a disabled client alike', async () => {
    const cookie = await signInAs(ADMIN);
    const unpoliced = await register('Plain RP', cookie);
    const disabledId = await register('Disabled RP', cookie, { signIn: { providers: ['microsoft'] } });
    const disable = await api.request(`http://localhost/clients/${disabledId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ disabled: true }),
    });
    expect(disable.status).toBe(200);

    const unrestricted = { providers: OFFERED, password: true, restricted: false };
    for (const id of ['no-such-client', unpoliced, disabledId, null]) {
      expect(clientSignIn(sql, id, OFFERED)).toEqual(unrestricted);
    }
  });

  it('does not invent a button for a provider the issuer no longer has', () => {
    // The operator deleted Microsoft after narrowing a client to it. An empty list and no
    // password is a client nobody can sign into — which the screen says, rather than falling
    // back to offering everything (the one behaviour that would turn this into an open door).
    expect(effectiveSignIn({ providers: ['microsoft'], password: false }, [{ id: 'google', label: 'Google' }])).toEqual({
      providers: [],
      password: false,
      restricted: true,
    });
  });
});

describe('reading an operator-written policy', () => {
  it('treats absence, junk and an empty object as no policy', () => {
    expect(sanitizeSignInPolicy(undefined)).toBeUndefined();
    expect(sanitizeSignInPolicy(null)).toBeUndefined();
    expect(sanitizeSignInPolicy('microsoft')).toBeUndefined();
    expect(sanitizeSignInPolicy(['microsoft'])).toBeUndefined();
    expect(sanitizeSignInPolicy({})).toBeUndefined();
    expect(sanitizeSignInPolicy({ typo: ['microsoft'] })).toBeUndefined();
  });

  it('reads a present-but-unreadable half as its DENY value, never as the default', () => {
    // The fail-open shape: a hand-written or corrupted row whose author plainly meant to deny
    // passwords. Reading the quoted `'false'` as the documented default would enable the one
    // method the policy exists to refuse — so a present key that does not parse denies.
    expect(sanitizeSignInPolicy({ providers: ['microsoft'], password: 'false' })).toEqual({
      providers: ['microsoft'],
      password: false,
    });
    // And the same the other way: `providers` present and unreadable is "no upstream", not
    // "any upstream". `[]` rather than `null` is exactly that difference.
    expect(sanitizeSignInPolicy({ providers: 'microsoft', password: true })).toEqual({
      providers: [],
      password: true,
    });
    expect(sanitizeSignInPolicy({ providers: ['MICROSOFT'] })).toEqual({ providers: [], password: true });
    // Absence is still the documented default — that is what keeps every existing client's
    // behaviour unchanged, and it is a different thing from a key that failed to parse.
    expect(sanitizeSignInPolicy({ providers: ['microsoft'] })).toEqual({
      providers: ['microsoft'],
      password: true,
    });
  });

  it('reads either half alone, and tells "any provider" from "no provider"', () => {
    expect(sanitizeSignInPolicy({ password: false })).toEqual({ providers: null, password: false });
    expect(sanitizeSignInPolicy({ providers: ['microsoft', 'microsoft'] })).toEqual({
      providers: ['microsoft'],
      password: true,
    });
    expect(sanitizeSignInPolicy({ providers: [] })).toEqual({ providers: [], password: true });
    // `null` is every provider the issuer offers; `[]` is none of them. `policyAdmits` is
    // where that distinction has to survive.
    expect(policyAdmits({ providers: null, password: false }, 'anything')).toBe(true);
    expect(policyAdmits({ providers: [], password: true }, 'anything')).toBe(false);
  });

  it('refuses an unstamped session under any policy, and admits it under none', () => {
    expect(policyAdmits(undefined, null)).toBe(true);
    expect(policyAdmits({ providers: null, password: true }, null)).toBe(false);
  });
});

describe('saving a policy', () => {
  it('refuses one that would lock everyone out', async () => {
    const cookie = await signInAs(ADMIN);
    const res = await api.request('http://localhost/clients', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        client_name: 'Impossible RP',
        redirect_uris: [RP_REDIRECT],
        application_type: 'native',
        metadata: { signIn: { providers: [], password: false } },
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('lock every user out');
  });

  it('refuses a misspelt key rather than storing a restriction that never applies', async () => {
    const cookie = await signInAs(ADMIN);
    const clientId = await register('Directory RP', cookie, { signIn: { providers: ['microsoft'] } });
    const res = await api.request(`http://localhost/clients/${clientId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ metadata: { signIn: { provider: ['microsoft'] } } }),
    });
    expect(res.status).toBe(400);
    // And the stored policy is untouched — a refused save must not half-apply.
    expect(readSignInPolicy(sql, clientId)).toEqual({ providers: ['microsoft'], password: true });
  });

  it('accepts each half on its own', () => {
    expect(assertSignInPolicy({ providers: ['microsoft'] })).toEqual({ providers: ['microsoft'], password: true });
    expect(assertSignInPolicy({ password: false })).toEqual({ providers: null, password: false });
    expect(() => assertSignInPolicy({ providers: ['Microsoft'] })).toThrow();
  });
});
