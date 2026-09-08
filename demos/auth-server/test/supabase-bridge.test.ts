import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';
import { supabaseBridgeFrom } from '../src/settings.js';

/**
 * Signing in with a token a Supabase project already issued — `POST /supabase/session`.
 *
 * `supabase-token.test.ts` holds what makes a token believable. This file holds what happens
 * to the person once it is: which account they land in, what stops them landing in somebody
 * else's, and the two ways the endpoint can refuse someone whose token was perfectly valid.
 *
 * The account key is the pair `(project issuer, Supabase sub)` — the same pair `genericOAuth`
 * would write if the project later migrated to signing keys and moved to the redirect flow.
 * The last test in the first block is what makes that claim mean something.
 */

const ORIGIN = 'http://localhost:8877';
const SECRET = 'super-secret-legacy-jwt-secret-value';
const PROJECT = 'https://abcdefghijklmnopqrst.supabase.co';
const ISSUER = `${PROJECT}/auth/v1`;
const LOCAL = { email: 'both@auth.test', password: 'local-account-pass', name: 'Local Account' };

let db: Database.Database;
let auth: Auth;
/** The operator's two decisions, as `supabaseBridgeFrom` resolves them before `buildAuth`. */
let allowSignup: boolean;
let autoLinkAccounts: boolean;

const b64url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const encodeJson = (value: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(value)));

async function mint(over: Record<string, unknown> = {}, secret = SECRET): Promise<string> {
  const claims = {
    iss: ISSUER,
    sub: 'supabase-user-1',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'newcomer@supabase.test',
    exp: Math.floor(Date.now() / 1000) + 3600,
    user_metadata: { name: 'A Newcomer', email_verified: true },
    ...over,
  };
  const data = `${encodeJson({ alg: 'HS256', typ: 'JWT' })}.${encodeJson(claims)}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

/** Better Auth with the bridge configured as the runtimes configure it — through the same
 *  reader, so a test cannot accidentally hand the plugin a shape the config could not make. */
function rebuild(cfg: Record<string, string | undefined> = {}): Auth {
  return buildAuth({
    database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
    secret: 'test-secret-000000000000000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: new MockEmailTransport(),
    sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    allowSignup: true,
    supabase: supabaseBridgeFrom(
      {
        SUPABASE_LEGACY_JWT_SECRET: SECRET,
        SUPABASE_ISSUER: ISSUER,
        SUPABASE_ALLOW_SIGNUP: allowSignup ? 'true' : 'false',
        ...cfg,
      },
      autoLinkAccounts,
    ),
  });
}

const post = (token: string): Promise<Response> =>
  auth.handler(
    new Request(`${ORIGIN}/api/auth/supabase/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }) as never,
  );

const users = (): { id: string; email: string; email_verified: number }[] =>
  db.prepare('SELECT id, email, email_verified FROM user ORDER BY email').all() as never;
const accounts = (): { user_id: string; provider_id: string; issuer: string; account_id: string }[] =>
  db.prepare('SELECT user_id, provider_id, issuer, account_id FROM account ORDER BY provider_id').all() as never;

beforeEach(() => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  allowSignup = true;
  autoLinkAccounts = true;
  auth = rebuild();
});

/** Give this issuer a local password account at an address, verified or not. */
async function seedLocal(emailVerified: boolean): Promise<string> {
  const created = await auth.api.signUpEmail({ body: LOCAL });
  db.prepare('UPDATE user SET email_verified = ? WHERE id = ?').run(emailVerified ? 1 : 0, created.user.id);
  return created.user.id;
}

describe('signing in with a Supabase token', () => {
  it('creates the account, sets a session, and keys it on the project and the sub', async () => {
    const res = await post(await mint());
    expect(res.status).toBe(200);
    // A session cookie, not merely a 200 — the endpoint's whole job is to end in one.
    expect(res.headers.getSetCookie().join(';')).toContain('session_token');

    expect(users()).toMatchObject([{ email: 'newcomer@supabase.test' }]);
    expect(accounts()).toEqual([
      { user_id: users()[0]!.id, provider_id: 'supabase', issuer: ISSUER, account_id: 'supabase-user-1' },
    ]);
  });

  it('never inherits the upstream’s verified flag onto the local address', async () => {
    // Supabase said the address is verified, and that decided whether this person could be
    // JOINED to an existing account. It must not also decide whether a LATER upstream may
    // join this one: that is a different question, about an account Supabase never saw.
    await post(await mint());
    expect(users()[0]!.email_verified).toBe(0);
  });

  it('lands the same person in the same account the second time', async () => {
    await post(await mint());
    // A new token for the same subject — different issue time, different signature.
    const again = await post(await mint({ email: 'renamed@supabase.test' }));
    expect(again.status).toBe(200);
    expect(users()).toHaveLength(1);
    expect(accounts()).toHaveLength(1);
  });

  it('keeps two different Supabase users apart', async () => {
    await post(await mint());
    await post(await mint({ sub: 'supabase-user-2', email: 'second@supabase.test' }));
    expect(users()).toHaveLength(2);
    expect(accounts().map((a) => a.account_id).sort()).toEqual(['supabase-user-1', 'supabase-user-2']);
  });

  it('refuses every bad token with the SAME words, so it is not an oracle', async () => {
    // The verifier distinguishes a forged signature from another project's token from the
    // public anon key. Telling a caller WHICH would let them probe the configuration.
    const reasons = await Promise.all([
      post(await mint({}, 'the-wrong-secret')),
      post(await mint({ iss: 'https://elsewhere.supabase.co/auth/v1' })),
      post(await mint({ role: 'anon' })),
      post(await mint({ role: 'service_role' })),
      post(await mint({ exp: Math.floor(Date.now() / 1000) - 60 })),
      post('not-even-a-jwt'),
    ]);
    for (const res of reasons) {
      expect(res.status).toBe(401);
      expect(((await res.json()) as { message?: string }).message).toBe('That Supabase token was not accepted.');
    }
    expect(users()).toHaveLength(0);
  });
});

describe('when the address already belongs to an account here', () => {
  it('joins them under `link`, when both sides have proved the address', async () => {
    const localId = await seedLocal(true);
    const res = await post(await mint({ email: LOCAL.email }));

    expect(res.status).toBe(200);
    // One person, two ways in — not a second account at the same address, which the schema
    // could not hold anyway.
    expect(users()).toHaveLength(1);
    expect(accounts().map((a) => a.provider_id)).toEqual(['credential', 'supabase']);
    expect(accounts().every((a) => a.user_id === localId)).toBe(true);
  });

  it('refuses under `block`, which is the operator’s policy reaching this door too', async () => {
    // The reason this option exists: a plugin mints accounts through the internal adapter and
    // never passes through Better Auth's own linking rules, so an issuer set to `block` would
    // otherwise have a second door that quietly ignored it.
    autoLinkAccounts = false;
    auth = rebuild();
    await seedLocal(true);

    const res = await post(await mint({ email: LOCAL.email }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message?: string }).message).toContain('Sign-in methods');
    expect(users()).toHaveLength(1);
    expect(accounts().map((a) => a.provider_id)).toEqual(['credential']);
  });

  it('refuses when the LOCAL address was never proved, even under `link`', async () => {
    // The state an administrator-created account is in. Joining on Supabase's word alone would
    // let anyone who can register that address at Supabase become whoever holds it here.
    await seedLocal(false);
    const res = await post(await mint({ email: LOCAL.email }));
    expect(res.status).toBe(403);
    expect(accounts().map((a) => a.provider_id)).toEqual(['credential']);
  });

  it('refuses when SUPABASE has not proved the address, even under `link`', async () => {
    await seedLocal(true);
    const res = await post(await mint({ email: LOCAL.email, user_metadata: { email_verified: false } }));
    expect(res.status).toBe(403);
    expect(accounts().map((a) => a.provider_id)).toEqual(['credential']);
  });
});

describe('the operator’s two switches', () => {
  it('refuses a newcomer when the bridge may not create accounts', async () => {
    allowSignup = false;
    auth = rebuild();
    const res = await post(await mint());
    expect(res.status).toBe(403);
    expect(users()).toHaveLength(0);
  });

  it('still signs in someone who already has the account, with sign-up off', async () => {
    await post(await mint());
    allowSignup = false;
    auth = rebuild();
    expect((await post(await mint())).status).toBe(200);
  });

  it('does not mount the endpoint at all when the bridge is unconfigured', async () => {
    // Half a configuration is not a configuration: a secret with no issuer cannot say which
    // project a token came from. An endpoint that exists and always refuses would advertise a
    // way in that this issuer does not have.
    for (const cfg of [{ SUPABASE_LEGACY_JWT_SECRET: undefined }, { SUPABASE_ISSUER: undefined }]) {
      auth = rebuild(cfg);
      expect((await post(await mint())).status).toBe(404);
    }
  });
});
