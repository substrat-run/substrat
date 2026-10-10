/**
 * Verifying an access token a Supabase project issued, for a project still on the LEGACY
 * shared JWT secret (HS256).
 *
 * Why this exists beside the OAuth path. A Supabase project can be an ordinary OIDC upstream —
 * that is the `supabase` entry in the sign-in providers catalogue, and it is the better answer
 * whenever it is available. It is not available on the legacy secret: Supabase's own OAuth 2.1
 * server documentation says that requesting the `openid` scope "will fail with HS256", and an
 * id_token is what carries the subject in that flow. So a project that has not migrated its
 * JWT secret cannot be a redirect upstream at all, and the only thing it can offer is a token
 * it already issued to its own app. This file is what makes such a token admissible.
 *
 * It is a shared secret, and that is worth naming rather than smoothing over: anyone holding
 * it can mint a token for any user, which is Supabase's own stated reason for retiring it. The
 * operator accepts that when they paste it. What this file must not do is make the situation
 * WORSE than the secret already implies, and there are three specific ways it could:
 *
 *  1. **The anon key is a valid signature.** A legacy project's `anon` and `service_role` API
 *     keys are themselves HS256 JWTs signed with this same secret. The anon key is public — it
 *     ships in every browser bundle that talks to the project. A verifier that checked only
 *     the signature would therefore accept a credential printed in public JavaScript and mint
 *     a session from it. What separates them is the `role` claim, so this file requires
 *     `authenticated` and refuses every other value rather than allow-listing the two bad ones
 *     — a project can define more Postgres roles, and an unknown role must never be a login.
 *  2. **Algorithm confusion.** A token's own header must not be allowed to choose how it is
 *     verified. `alg` is pinned to HS256 and compared before anything else is read; `none` and
 *     every asymmetric algorithm are refused by that same test rather than by a special case.
 *  3. **Someone else's project.** The `iss` claim is checked against the configured issuer, so
 *     a token from a different Supabase project — or from the API keys, whose `iss` is the
 *     bare string `supabase` — is refused even before the role check reaches it.
 *
 * Everything here is Web Crypto and web-standard encoding, so it is the same code in the
 * Durable Object and in the Node dev server.
 */

/** Why a token was refused. The reason distinguishes the failures so a TEST can; the endpoint
 *  collapses every one of them into a single refusal, so it is never an oracle for probing. */
export class SupabaseTokenError extends Error {}

/** The person a verified token describes — the only thing that leaves this module. */
export interface SupabaseIdentity {
  /** Supabase's user id (`sub`). The account key, and stable across the legacy→OIDC move. */
  sub: string;
  email: string | null;
  /** Whether SUPABASE says the address is proved. Never assumed: it decides linking. */
  emailVerified: boolean;
  name: string | null;
}

export interface VerifyOptions {
  /** The project's legacy JWT secret — the HS256 key, as pasted. */
  secret: string;
  /** The issuer the token must declare, e.g. `https://abc.supabase.co/auth/v1`. */
  issuer: string;
  /** Milliseconds since the epoch. Injected so a test can pin it; defaults to the real clock,
   *  which is correct here — `exp` is a fact about wall time that the project asserted. */
  now?: number;
  /** Tolerance for clock drift between this issuer and Supabase. Deliberately small. */
  clockSkewSeconds?: number;
}

const DEFAULT_SKEW_SECONDS = 60;

/**
 * The `role` a token must carry. Supabase sets it to a Postgres role: `authenticated` for a
 * person its Auth service signed in, `anon` for the public API key, `service_role` for the
 * project-wide admin key. Only the first is a login. See the header for why this is an
 * equality test and not a denylist.
 */
const REQUIRED_ROLE = 'authenticated';

/** The `aud` Supabase stamps on a user's access token. */
const EXPECTED_AUDIENCE = 'authenticated';

/**
 * Normalize an issuer the way the sign-in providers panel does, so an operator who pastes the
 * PROJECT url rather than the auth url is not left reading a mismatch error about a suffix
 * nobody told them about. Anything with a path is taken as given.
 */
export function supabaseIssuerOf(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }
  return url.pathname === '/' ? `${trimmed}/auth/v1` : trimmed;
}

/** base64url → bytes. Padding is optional in base64url, so it is restored before decoding. */
function base64UrlToBytes(part: string): Uint8Array {
  const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new SupabaseTokenError('a segment is not valid base64url');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** base64url → parsed JSON. `TextDecoder`, so a non-ASCII name survives the trip. */
function jsonOf(part: string, what: string): Record<string, unknown> {
  const text = new TextDecoder().decode(base64UrlToBytes(part));
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SupabaseTokenError(`the ${what} is not JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SupabaseTokenError(`the ${what} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

function stringOr(value: unknown, fallback: string | null): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/**
 * Does the token's `aud` include what a user token's should? Present as a string or an array,
 * per RFC 7519, and both shapes mean the same thing.
 */
function audienceAccepts(aud: unknown): boolean {
  if (typeof aud === 'string') return aud === EXPECTED_AUDIENCE;
  if (Array.isArray(aud)) return aud.some((entry) => entry === EXPECTED_AUDIENCE);
  return false;
}

/**
 * Verify a Supabase access token and return who it is about. Throws `SupabaseTokenError` with
 * a reason for anything else — the caller turns every one of them into the SAME refusal, so a
 * caller probing this endpoint learns whether their token works and nothing further.
 */
export async function verifySupabaseToken(token: string, opts: VerifyOptions): Promise<SupabaseIdentity> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) {
    throw new SupabaseTokenError('not a three-part JWS');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  // 1. The algorithm, BEFORE anything else is read. A token must never choose how it is
  //    checked: `none` and every RS*/ES*/PS* value fail this same equality, so there is no
  //    "unsupported algorithm" branch that could be reached with a verification skipped.
  const header = jsonOf(encodedHeader, 'header');
  if (header.alg !== 'HS256') {
    throw new SupabaseTokenError(`unexpected alg '${String(header.alg)}' — only HS256 is accepted`);
  }

  // 2. The signature. `crypto.subtle.verify` compares in constant time, which a manual
  //    equality on the base64 text would not.
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(opts.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const ok = await crypto.subtle.verify('HMAC', key, base64UrlToBytes(encodedSignature), signed);
  if (!ok) throw new SupabaseTokenError('signature does not verify against the configured secret');

  const claims = jsonOf(encodedPayload, 'payload');

  // 3. The issuer. Also what refuses the project's own API keys before the role check does:
  //    those carry `iss: "supabase"`, not a project URL.
  const issuer = supabaseIssuerOf(opts.issuer);
  if (stringOr(claims.iss, null)?.replace(/\/+$/, '') !== issuer) {
    throw new SupabaseTokenError(`issued by '${String(claims.iss)}', which is not the configured project`);
  }

  // 4. The role. THE check that separates a signed-in person from the public anon key, which
  //    is signed with this very secret and printed in the project's own browser bundle.
  if (claims.role !== REQUIRED_ROLE) {
    throw new SupabaseTokenError(
      `role '${String(claims.role)}' is not a sign-in — only '${REQUIRED_ROLE}' is a person`,
    );
  }
  // Supabase's anonymous sign-in produces a real `authenticated` token for nobody in
  // particular. It is a session, not an identity, and must not become an account here.
  if (claims.is_anonymous === true) {
    throw new SupabaseTokenError('an anonymous Supabase session is not an identity');
  }
  if (!audienceAccepts(claims.aud)) {
    throw new SupabaseTokenError(`audience '${JSON.stringify(claims.aud)}' is not '${EXPECTED_AUDIENCE}'`);
  }

  // 5. Time. `exp` is required rather than optional: a token that never expires is a password
  //    that cannot be changed, and Supabase always sets one.
  // boundary-lint-allow R6
  // SUPABASE judged `exp` against ITS clock when it minted this token, and the question here
  // is whether that instant has passed in the real world — not whether it precedes some
  // operation instant of ours. A frozen or replayed clock would accept an expired token,
  // which is the one failure this check exists to prevent. `opts.now` is how the tests pin it.
  const now = opts.now ?? Date.now();
  // boundary-lint-end R6
  const skewMs = (opts.clockSkewSeconds ?? DEFAULT_SKEW_SECONDS) * 1000;
  if (typeof claims.exp !== 'number') throw new SupabaseTokenError('no exp — a token must expire');
  if (claims.exp * 1000 + skewMs <= now) throw new SupabaseTokenError('expired');
  for (const key of ['nbf', 'iat'] as const) {
    const value = claims[key];
    if (typeof value === 'number' && value * 1000 - skewMs > now) {
      throw new SupabaseTokenError(`${key} is in the future`);
    }
  }

  const sub = stringOr(claims.sub, null);
  if (!sub) throw new SupabaseTokenError('no sub — nothing to key an account on');

  // Supabase puts the verified-address flag in `user_metadata` and, on newer projects, at the
  // top level too. Absent reads as NOT verified: this flag decides whether the person may be
  // joined to a local account that already holds the address, so an absence must never be
  // read as a yes.
  const metadata =
    claims.user_metadata && typeof claims.user_metadata === 'object' && !Array.isArray(claims.user_metadata)
      ? (claims.user_metadata as Record<string, unknown>)
      : {};
  const emailVerified = claims.email_verified === true || metadata.email_verified === true;

  return {
    sub,
    email: stringOr(claims.email, null)?.toLowerCase() ?? null,
    emailVerified,
    name: stringOr(metadata.name, null) ?? stringOr(metadata.full_name, null),
  };
}
