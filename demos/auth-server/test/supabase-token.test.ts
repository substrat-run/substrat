import { describe, it, expect } from 'vitest';
import { SupabaseTokenError, supabaseIssuerOf, verifySupabaseToken } from '../src/supabase-token.js';

/**
 * What a Supabase access token has to prove before this issuer will believe it.
 *
 * The shape of this file follows from one fact: on a legacy project, the JWT secret signs more
 * than people. The project's `anon` API key — the one printed in every browser bundle that
 * talks to it — is itself an HS256 JWT signed with this secret, and so is `service_role`, the
 * project-wide admin key. A verifier that checked the signature and stopped would therefore
 * accept a public string as proof of identity. So most of what is pinned here is REFUSAL, and
 * the first test below is the one that matters.
 */

const SECRET = 'super-secret-legacy-jwt-secret-value';
const PROJECT = 'https://abcdefghijklmnopqrst.supabase.co';
const ISSUER = `${PROJECT}/auth/v1`;
/** A fixed "now", so an `exp` in a fixture is a decision rather than a race. */
const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);
const IN_AN_HOUR = Math.floor(NOW / 1000) + 3600;

const b64url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const encodeJson = (value: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(value)));

/** Mint a token the way Supabase would — and, with `secret`/`header` overridden, the way an
 *  attacker would. */
async function mint(
  claims: Record<string, unknown>,
  over: { secret?: string; header?: Record<string, unknown>; signature?: string } = {},
): Promise<string> {
  const data = `${encodeJson(over.header ?? { alg: 'HS256', typ: 'JWT' })}.${encodeJson(claims)}`;
  if (over.signature !== undefined) return `${data}.${over.signature}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(over.secret ?? SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

/** A person Supabase Auth signed in — the only kind of token that is a login. */
const person = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: ISSUER,
  sub: '2f1c9b3e-0000-4000-8000-abcdefabcdef',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'Person@Example.test',
  exp: IN_AN_HOUR,
  iat: Math.floor(NOW / 1000),
  user_metadata: { name: 'A Person', email_verified: true },
  ...over,
});

const verify = (token: string, over: Partial<Parameters<typeof verifySupabaseToken>[1]> = {}) =>
  verifySupabaseToken(token, { secret: SECRET, issuer: ISSUER, now: NOW, ...over });

const refusal = async (token: string, over?: Partial<Parameters<typeof verifySupabaseToken>[1]>) => {
  const error = await verify(token, over).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, 'expected the token to be REFUSED, and it was accepted').toBeInstanceOf(SupabaseTokenError);
  return (error as SupabaseTokenError).message;
};

describe('the credentials this secret also signs, which are not logins', () => {
  it('refuses the project’s public anon key', async () => {
    // THE test. This is a real legacy anon key's shape: same secret, no subject, `iss` the
    // bare string "supabase", and the role that gives it away. It is public — it ships in the
    // project's own JavaScript — so accepting it would make every visitor an account holder.
    const anonKey = await mint({ iss: 'supabase', role: 'anon', iat: 1, exp: IN_AN_HOUR });
    expect(await refusal(anonKey)).toContain('supabase');

    // And with the issuer corrected, so the refusal does not depend on that one check alone:
    // defence in depth is the point, since a future key format could carry a project issuer.
    const anonFromProject = await mint({ ...person(), role: 'anon' });
    expect(await refusal(anonFromProject)).toContain('anon');
  });

  it('refuses the service_role key, which is the project’s admin credential', async () => {
    expect(await refusal(await mint({ ...person(), role: 'service_role' }))).toContain('service_role');
  });

  it('refuses a role it has never heard of, rather than allow-listing the two bad ones', async () => {
    // A project can define more Postgres roles. An unknown one is not a login by default.
    expect(await refusal(await mint({ ...person(), role: 'reporting_readonly' }))).toContain('reporting_readonly');
    expect(await refusal(await mint({ ...person(), role: undefined }))).toContain('undefined');
  });

  it('refuses an anonymous Supabase session — a session, but nobody', async () => {
    // Supabase's anonymous sign-in issues a genuine `authenticated` token. It is not an
    // identity, and must not become an account here.
    expect(await refusal(await mint({ ...person(), is_anonymous: true }))).toContain('anonymous');
  });
});

describe('the signature, and what a token may not decide about its own checking', () => {
  it('refuses every algorithm but HS256, including none', async () => {
    // Algorithm confusion: the header must not choose the verification. `none` and an
    // asymmetric alg fail the same equality, so there is no branch where a check is skipped.
    for (const alg of ['none', 'RS256', 'ES256', 'HS384', 'hs256']) {
      const token = await mint(person(), { header: { alg, typ: 'JWT' } });
      expect(await refusal(token)).toContain('HS256');
    }
  });

  it('refuses a token signed with a different secret, and a forged signature', async () => {
    expect(await refusal(await mint(person(), { secret: 'not-the-projects-secret' }))).toContain('signature');
    expect(await refusal(await mint(person(), { signature: 'AAAA' }))).toContain('signature');
  });

  it('refuses anything that is not a three-part JWS', async () => {
    for (const bogus of ['', 'one.two', 'one.two.three.four', 'a..c']) {
      expect(await refusal(bogus)).toContain('three-part');
    }
  });
});

describe('which project, and when', () => {
  it('refuses a token from another Supabase project', async () => {
    // A valid signature says a token came from someone holding THIS secret; the issuer is what
    // says it came from the project the operator configured.
    const other = await mint({ ...person(), iss: 'https://someone-else.supabase.co/auth/v1' });
    expect(await refusal(other)).toContain('someone-else');
  });

  it('accepts the project URL as the configured issuer, adding the suffix', async () => {
    // The same kindness the sign-in providers panel does: `/auth/v1` is the part nobody guesses.
    expect(supabaseIssuerOf(PROJECT)).toBe(ISSUER);
    expect(supabaseIssuerOf(`${PROJECT}/`)).toBe(ISSUER);
    expect(supabaseIssuerOf(ISSUER)).toBe(ISSUER);
    const identity = await verify(await mint(person()), { issuer: PROJECT });
    expect(identity.sub).toBe(person().sub);
  });

  it('requires an exp, and honours it', async () => {
    // A token with no expiry is a password that cannot be changed.
    expect(await refusal(await mint({ ...person(), exp: undefined }))).toContain('exp');
    const expired = await mint({ ...person(), exp: Math.floor(NOW / 1000) - 3600 });
    expect(await refusal(expired)).toContain('expired');
    // Just inside the skew: a minute of drift between two clocks is not an attack.
    const justExpired = await mint({ ...person(), exp: Math.floor(NOW / 1000) - 30 });
    expect((await verify(justExpired)).sub).toBeTruthy();
  });

  it('refuses a token issued for the future, and one addressed to something else', async () => {
    expect(await refusal(await mint({ ...person(), iat: Math.floor(NOW / 1000) + 600 }))).toContain('iat');
    expect(await refusal(await mint({ ...person(), aud: 'anon' }))).toContain('audience');
    expect(await refusal(await mint({ ...person(), sub: undefined }))).toContain('sub');
  });
});

describe('what a verified token says about the person', () => {
  it('returns the subject, a normalized address, and the name', async () => {
    const identity = await verify(await mint(person()));
    expect(identity).toEqual({
      sub: '2f1c9b3e-0000-4000-8000-abcdefabcdef',
      // Lowercased, because it is about to be compared against local accounts, and Better
      // Auth stores and looks up addresses in lower case.
      email: 'person@example.test',
      emailVerified: true,
      name: 'A Person',
    });
  });

  it('reads the verified flag from either place, and treats its absence as NO', async () => {
    // This flag decides whether the person may be joined to an account that already holds the
    // address, so an absence must never read as a yes.
    const topLevel = await verify(await mint({ ...person(), user_metadata: {}, email_verified: true }));
    expect(topLevel.emailVerified).toBe(true);
    const neither = await verify(await mint({ ...person(), user_metadata: { name: 'A Person' } }));
    expect(neither.emailVerified).toBe(false);
    const explicitlyFalse = await verify(
      await mint({ ...person(), user_metadata: { email_verified: false }, email_verified: false }),
    );
    expect(explicitlyFalse.emailVerified).toBe(false);
  });

  it('survives a token with no email and a non-ASCII name', async () => {
    const identity = await verify(
      await mint({ ...person(), email: undefined, user_metadata: { full_name: 'Åsa Öberg' } }),
    );
    expect(identity.email).toBeNull();
    expect(identity.name).toBe('Åsa Öberg');
  });
});
