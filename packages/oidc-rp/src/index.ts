/**
 * The Substrat platform's OpenID Connect **relying party** — shared by the
 * platform apps (console, dashboard) so the security-critical verifier is written
 * once, not copied per app.
 *
 * It authenticates against the platform's AuthHero instance (the Auth0-compatible
 * OIDC authority). The kernel keeps authorization (roles/grants/tenancy); this
 * package only proves *who* the caller is — the `sub` (and `email`), taken from the
 * ID token and, for the claims OIDC Core §5.4 routes to UserInfo instead, from there.
 *
 * Standard Authorization-Code + PKCE, discovery-driven so nothing but the issuer
 * URL is wired in: endpoints and signing keys come from
 * `{issuer}/.well-known/openid-configuration`. Confidential client (server-side
 * code exchange with the client secret), and the ID token is signature-verified
 * against the issuer JWKS.
 *
 * Stateless: no KV, no D1. The short-lived PKCE/state/nonce rides a signed "flow"
 * cookie; the session is a signed JWT cookie. Both are HMAC-signed with
 * `SESSION_SECRET`. workerd-safe — Web Crypto + `jose` only, no `node:*`.
 *
 * Config is entirely runtime (secrets), never checked in:
 *   OIDC_ISSUER · OIDC_CLIENT_ID · OIDC_CLIENT_SECRET · SESSION_SECRET
 */
import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import type { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

export interface OidcEnv {
  /** The AuthHero issuer, e.g. https://auth.substrat.run — the only wired-in value. */
  OIDC_ISSUER: string;
  OIDC_CLIENT_ID: string;
  /** Secret (wrangler secret put OIDC_CLIENT_SECRET). */
  OIDC_CLIENT_SECRET: string;
  /** Secret (wrangler secret put SESSION_SECRET) — signs the flow + session cookies. */
  SESSION_SECRET: string;
  /** If set, the redirect origin is forced to this (else derived from the request). */
  BASE_URL?: string;
}

export interface SessionUser {
  id: string;
  email?: string;
  name?: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

export const SESSION_COOKIE = 'sb_session';
export const FLOW_COOKIE = 'sb_oidc_flow';
/**
 * The ID token from the login round-trip, kept ONLY to be handed back to the issuer as
 * `id_token_hint` on a federated logout (below). Its own cookie rather than a claim in
 * the session, and scoped to the logout path, so it rides exactly one request in the
 * session's life instead of every one — a hint is not a credential this app ever reads.
 */
export const LOGOUT_HINT_COOKIE = 'sb_oidc_idt';
/** Path the hint cookie is scoped to — must match wherever the logout route is mounted. */
const LOGOUT_PATH = '/api/auth/logout';
/** Session lifetime; the flow (login round-trip) is deliberately short. */
export const SESSION_MAXAGE = 60 * 60 * 24 * 7; // 7 days
export const FLOW_MAXAGE = 60 * 10; // 10 minutes
/**
 * How long the optional UserInfo enrichment may take before the login proceeds without
 * it. This call sits inside the user's redirect, so the ceiling is what a person will
 * wait, not what a background job would — deliberately far below the connectors' 15–30s.
 */
export const USERINFO_TIMEOUT_MS = 5_000;

const enc = new TextEncoder();

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const randomB64url = (n = 32): string => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
}

// Discovery + JWKS, cached per issuer for the life of the isolate.
const discoveryCache = new Map<string, Promise<Discovery>>();
function discover(issuer: string): Promise<Discovery> {
  const key = issuer.replace(/\/$/, '');
  let p = discoveryCache.get(key);
  if (!p) {
    const url = `${key}/.well-known/openid-configuration`;
    p = fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`OIDC discovery failed (${r.status}) at ${url}`);
      return (await r.json()) as Discovery;
    });
    discoveryCache.set(key, p);
  }
  return p;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(d: Discovery): ReturnType<typeof createRemoteJWKSet> {
  let j = jwksCache.get(d.jwks_uri);
  if (!j) {
    j = createRemoteJWKSet(new URL(d.jwks_uri));
    jwksCache.set(d.jwks_uri, j);
  }
  return j;
}

const signingKey = (env: OidcEnv): Uint8Array => enc.encode(env.SESSION_SECRET);
const redirectUri = (env: OidcEnv, origin: string): string =>
  `${(env.BASE_URL ?? origin).replace(/\/$/, '')}/api/auth/callback`;

/**
 * Begin login: the authorize-endpoint URL to redirect to, and the signed flow
 * cookie value that carries PKCE verifier + state + nonce across the round-trip.
 */
export async function beginLogin(
  env: OidcEnv,
  origin: string,
  opts: { returnTo?: string; loginHint?: string; screenHint?: string; prompt?: 'login' | 'select_account' } = {},
): Promise<{ location: string; flow: string }> {
  const d = await discover(env.OIDC_ISSUER);
  const verifier = randomB64url(32);
  const state = randomB64url(16);
  const nonce = randomB64url(16);
  // `rt` (an already-validated same-origin path) rides the signed, short-lived flow
  // cookie so the callback can send the browser back where login began.
  const claims: Record<string, unknown> = { v: verifier, s: state, n: nonce };
  if (opts.returnTo) claims.rt = opts.returnTo;
  const flow = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${FLOW_MAXAGE}s`)
    .sign(signingKey(env));

  const u = new URL(d.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', env.OIDC_CLIENT_ID);
  u.searchParams.set('redirect_uri', redirectUri(env, origin));
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', await pkceChallenge(verifier));
  u.searchParams.set('code_challenge_method', 'S256');
  // Optional UX hints (both AuthHero/Auth0-standard, ignored by IdPs that don't
  // support them): `login_hint` prefills the email field (e.g. from an invite), and
  // `screen_hint=signup` opens the sign-up view for a first-time invitee.
  if (opts.loginHint) u.searchParams.set('login_hint', opts.loginHint);
  if (opts.screenHint) u.searchParams.set('screen_hint', opts.screenHint);
  // `prompt=login` forces re-authentication even when the IdP holds a live SSO
  // session — the "sign in as a different account" escape hatch (the IdP session
  // otherwise silently re-authenticates the old user, and no typed email can win).
  if (opts.prompt) u.searchParams.set('prompt', opts.prompt);
  return { location: u.toString(), flow };
}

/**
 * Complete login: verify state against the flow cookie, exchange the code for
 * tokens, verify the ID token (signature via JWKS, plus issuer/audience/nonce),
 * and return the user + a signed session cookie value.
 */
export async function completeLogin(
  env: OidcEnv,
  origin: string,
  url: URL,
  flowCookie: string | undefined,
): Promise<{ user: SessionUser; session: string; returnTo?: string; idToken: string }> {
  const oauthError = url.searchParams.get('error');
  if (oauthError) throw new Error(`authorization error: ${oauthError}`);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) throw new Error('missing code or state');
  if (!flowCookie) throw new Error('missing login flow cookie');

  let flow: { v: string; s: string; n: string; rt?: string };
  try {
    flow = (await jwtVerify(flowCookie, signingKey(env))).payload as unknown as typeof flow;
  } catch {
    throw new Error('invalid or expired login flow');
  }
  if (flow.s !== state) throw new Error('state mismatch');

  const d = await discover(env.OIDC_ISSUER);
  const res = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(env, origin),
      client_id: env.OIDC_CLIENT_ID,
      client_secret: env.OIDC_CLIENT_SECRET,
      code_verifier: flow.v,
    }),
  });
  if (!res.ok) {
    // Surface the authority's own error body — this is the non-2xx path, so it is an
    // error payload, never the token response, and nothing secret leaks. Capped and
    // logged server-side (Workers Logs) only; the browser still gets the opaque redirect.
    const detail = await res.text().catch(() => '');
    throw new Error(`token exchange failed (${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }
  const tokens = (await res.json()) as { id_token?: string; access_token?: string };
  if (!tokens.id_token) throw new Error('no id_token in token response');

  const { payload } = await jwtVerify(tokens.id_token, jwksFor(d), {
    issuer: d.issuer,
    audience: env.OIDC_CLIENT_ID,
  });
  if (payload.nonce !== flow.n) throw new Error('nonce mismatch');

  const user = await withUserInfo(d, userFromClaims(payload), tokens.access_token);
  const session = await mintSession(env, user);
  // The verified ID token travels back out so the caller can keep it for logout. It is
  // returned rather than stored here because this function is stateless — the CLI login
  // broker calls it too, and holds no cookies.
  return {
    user,
    session,
    returnTo: typeof flow.rt === 'string' ? flow.rt : undefined,
    idToken: tokens.id_token,
  };
}

/**
 * Fill in the profile claims the ID token did not carry, from the UserInfo endpoint.
 *
 * We asked for `scope=openid email profile` and used to read the answer out of the ID
 * token alone. That is only half of where OIDC puts it. **OIDC Core §5.4 routes
 * scope-requested claims to UserInfo whenever an access token is issued** — which the
 * authorization-code flow always does — so a spec-faithful provider hands back an ID
 * token carrying `sub` and the protocol claims, and nothing else. Providers differ here
 * and both readings are correct: some include the profile anyway (Auth0's lineage does,
 * and its compatibility flag says so out loud), some do not.
 *
 * Reading only the ID token therefore silently produced a session with an id and no
 * address, against a provider doing exactly what the spec says. That is worse than it
 * sounds wherever the address is the identifier: a relying party that resolves a local
 * account by e-mail gets no thread to follow, mints something derived from the `sub`
 * instead, and the person lands authenticated and unrecognised — a working login with
 * no access, and no error anywhere to explain it.
 *
 * Four things this is careful about:
 *
 *  - **Only when something is missing.** A provider that already puts the claims in the
 *    ID token costs no extra round trip, and its behaviour is unchanged.
 *  - **The ID token still wins.** UserInfo fills gaps; it never overwrites a claim that
 *    was signed into the token we already verified.
 *  - **`sub` is verified (OIDC Core §5.3.2).** A UserInfo response whose subject differs
 *    from the ID token's is exactly the substitution the check exists to catch, so it
 *    throws rather than being ignored — every other integrity failure in this flow
 *    (state, nonce, signature) throws too, and the caller renders them all the same way.
 *  - **Transport problems degrade, they do not fail.** No endpoint advertised, no access
 *    token, a non-2xx, unreadable JSON, an endpoint that accepts the connection and then
 *    says nothing: the login stands with what the ID token gave. The ID token is the
 *    authentication; this is enrichment, and enrichment must not be able to lock anyone
 *    out — which is why the call carries a deadline. A `fetch` with no `signal` has no
 *    timeout of its own, so a stalled endpoint would hang the login callback for as long
 *    as the runtime allowed, and the enrichment would lock out exactly the bare-token
 *    users it exists to help.
 */
async function withUserInfo(
  d: Discovery,
  user: SessionUser,
  accessToken: string | undefined,
): Promise<SessionUser> {
  if (user.email !== undefined && user.name !== undefined) return user;
  if (!d.userinfo_endpoint || !accessToken) return user;

  let claims: { sub?: unknown; email?: unknown; name?: unknown };
  try {
    const res = await fetch(d.userinfo_endpoint, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(USERINFO_TIMEOUT_MS),
    });
    if (!res.ok) return user;
    claims = (await res.json()) as typeof claims;
  } catch {
    return user;
  }

  // §5.3.2: "The sub Claim in the UserInfo Response MUST be verified to exactly match
  // the sub Claim in the ID Token; if they do not match, the UserInfo Response values
  // MUST NOT be used." Not using them is the floor; refusing the login says it out loud,
  // because a mismatch is never a quirk — it is a response for a different subject.
  if (typeof claims.sub !== 'string' || claims.sub !== user.id) {
    throw new Error('userinfo sub does not match the id_token sub');
  }

  return {
    id: user.id,
    email: user.email ?? (typeof claims.email === 'string' ? claims.email : undefined),
    name: user.name ?? (typeof claims.name === 'string' ? claims.name : undefined),
  };
}

/**
 * Mint a signed session token for a user — the same HS256/`SESSION_SECRET` token the
 * login callback sets as the `sb_session` cookie, and that `verifySession` accepts.
 * Exported so a non-browser caller (the CLI login broker) can be handed a session to
 * carry as a bearer, rather than a cookie.
 */
export async function mintSession(
  env: OidcEnv,
  user: SessionUser,
  maxAgeSec: number = SESSION_MAXAGE,
): Promise<string> {
  return new SignJWT({ email: user.email, name: user.name })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${maxAgeSec}s`)
    .sign(signingKey(env));
}

function userFromClaims(payload: { sub?: unknown; email?: unknown; name?: unknown }): SessionUser {
  return {
    id: String(payload.sub),
    email: typeof payload.email === 'string' ? payload.email : undefined,
    name: typeof payload.name === 'string' ? payload.name : undefined,
  };
}

/**
 * PKCE S256: the base64url SHA-256 of a verifier — the value a caller sends as
 * `code_challenge` and the server later recomputes from the verifier to bind an
 * exchange to the client that began it. Exported so the CLI login broker can use the
 * same construction the OIDC flow already uses internally.
 */
export function pkceS256(verifier: string): Promise<string> {
  return pkceChallenge(verifier);
}

/**
 * Sign / verify a short-lived HS256 token with `SESSION_SECRET` — the generic
 * primitive behind the flow cookie and the CLI login `code`. Not a session (no `sub`
 * contract); just a tamper-proof, expiring envelope for a handful of claims.
 */
export function signEphemeral(env: OidcEnv, claims: Record<string, unknown>, maxAgeSec: number): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${maxAgeSec}s`)
    .sign(signingKey(env));
}

export async function verifyEphemeral(env: OidcEnv, token: string): Promise<Record<string, unknown> | null> {
  try {
    return (await jwtVerify(token, signingKey(env))).payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Verify the session cookie value. `null` for no/invalid/expired session. */
export async function verifySession(
  env: OidcEnv,
  token: string | undefined,
): Promise<SessionUser | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, signingKey(env));
    if (!payload.sub) return null;
    return userFromClaims(payload);
  } catch {
    return null;
  }
}

/** Read one cookie value out of a raw `Cookie` header. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** Convenience: the session behind a request's `Cookie` header (framework-agnostic). */
export function sessionFromHeaders(env: OidcEnv, headers: Headers): Promise<SessionUser | null> {
  return verifySession(env, readCookie(headers.get('cookie'), SESSION_COOKIE));
}

/**
 * Vouch for the session above to a widget embedded from ANOTHER origin —
 * HMAC-SHA-256 over the subject, hex, keyed by a secret that widget's backend also
 * holds. This is the construction Intercom calls `user_hash` and Help Scout calls a
 * Beacon signature, and Substrat's own support desk (ticket0) verifies exactly it.
 *
 * It lives here, beside the thing it vouches FOR, for the reason this whole package
 * exists: the console and the dashboard both embed the desk, so the alternative is
 * the same security-critical MAC written twice, in two workers, with two chances to
 * disagree about encoding. What must never move is which side computes it — the
 * secret stays server-side and the browser only carries the result, which is the
 * entire reason a visitor cannot claim somebody else's identity in devtools.
 *
 * The claim is the subject and nothing else: no expiry, no origin binding. That is
 * the receiving end's model, not a shortcut taken here — a signature is a durable
 * assertion that this deployment believes the bearer is `subject`, so it is minted
 * only for the session's own identity and served `no-store`.
 */
export async function signVisitorIdentity(secret: string, subject: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(subject));
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const cookieOpts = (
  origin: string,
  maxAge: number,
  path = '/',
  sameSite: 'Lax' | 'Strict' = 'Lax',
) => ({
  httpOnly: true,
  secure: origin.startsWith('https:'),
  sameSite,
  path,
  maxAge,
});

/**
 * Loopback hosts, where OAuth 2.1 still permits plain HTTP for local development —
 * `packages/dev-issuer` is exactly that, and every demo's dev login runs through it.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** HTTPS, or HTTP on a loopback host. The same rule the issuer applies to its own upstreams. */
function isHttpsOrLoopback(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
}

export interface MountOptions {
  /** Where to send the browser after a successful login (default '/'). */
  onSuccess?: string;
  /** Where to send after a failed login (default '/?error=auth'). */
  onError?: string;
}

/**
 * A same-origin absolute path, or undefined. Guards the `returnTo` redirect against
 * open-redirect: only a path beginning with a single `/` (no scheme, no `//` network
 * path, no backslash) is allowed — never an absolute URL to another host.
 */
export function safePath(p: string | null | undefined): string | undefined {
  if (!p || !p.startsWith('/') || p.startsWith('//') || p.includes('\\')) return undefined;
  return p;
}

/**
 * Mount `/api/auth/login`, `/api/auth/callback`, `/api/auth/logout` on a Hono app.
 * Both platform apps wire the routes identically — cookie flags, redirects and the
 * PKCE round-trip — so the only per-app difference is what happens *after* the
 * session exists (JIT tenant bootstrap vs. staff-roster lookup), which stays in the
 * app. Account switching: `/api/auth/login?prompt=login` forces the IdP to
 * re-authenticate past its SSO cookie; `/api/auth/logout?federated` also ends the
 * IdP session itself.
 */
export function mountOidcRoutes<B extends OidcEnv>(app: Hono<{ Bindings: B }>, opts: MountOptions = {}): void {
  const onSuccess = opts.onSuccess ?? '/';
  const onError = opts.onError ?? '/?error=auth';

  app.get('/api/auth/login', async (c) => {
    const origin = new URL(c.req.url).origin;
    // `screen_hint` and `prompt` are allowlisted (only IdP-recognised values);
    // `login_hint` is passed through — the authorize URL builder encodes it, and the
    // IdP validates it.
    const screen = c.req.query('screen_hint');
    const prompt = c.req.query('prompt');
    const { location, flow } = await beginLogin(c.env, origin, {
      returnTo: safePath(c.req.query('returnTo')),
      loginHint: c.req.query('login_hint') || undefined,
      screenHint: screen === 'signup' || screen === 'login' ? screen : undefined,
      prompt: prompt === 'login' || prompt === 'select_account' ? prompt : undefined,
    });
    setCookie(c, FLOW_COOKIE, flow, cookieOpts(origin, FLOW_MAXAGE));
    return c.redirect(location);
  });

  app.get('/api/auth/callback', async (c) => {
    const origin = new URL(c.req.url).origin;
    const flow = getCookie(c, FLOW_COOKIE);
    deleteCookie(c, FLOW_COOKIE, { path: '/' });
    try {
      const { session, returnTo, idToken } = await completeLogin(c.env, origin, new URL(c.req.url), flow);
      setCookie(c, SESSION_COOKIE, session, cookieOpts(origin, SESSION_MAXAGE));
      // Kept for `id_token_hint` at logout — see the logout route. Same lifetime as the
      // session, so the two expire together and a stale hint is never the thing left over.
      //
      // `SameSite=Strict`, unlike the session cookie's `Lax`: a top-level GET navigation
      // IS sent with a Lax cookie, so a hostile page linking to `?federated` would hand
      // the OP a valid hint and get the very confirmation page this feature removes
      // skipped — logout CSRF against the IdP session. Strict withholds the hint from
      // any cross-site navigation, which downgrades that case to the confirmation page
      // and leaves the in-app sign-out (same-site) redirecting straight through. The
      // session cookie stays Lax because the login callback is itself a cross-site
      // navigation back from the issuer and must arrive carrying it.
      setCookie(
        c,
        LOGOUT_HINT_COOKIE,
        idToken,
        cookieOpts(origin, SESSION_MAXAGE, LOGOUT_PATH, 'Strict'),
      );
      return c.redirect(safePath(returnTo) ?? onSuccess);
    } catch (err) {
      // Never swallow silently: a failing login round-trip is undiagnosable in prod
      // otherwise. The reason (token-exchange status, state/nonce mismatch, JWKS
      // verify) goes to Workers Logs; the browser still gets the opaque onError
      // redirect so nothing leaks to the caller.
      console.error('oidc.callback.failed', { reason: err instanceof Error ? err.message : String(err) });
      return c.redirect(onError);
    }
  });

  app.get(LOGOUT_PATH, async (c) => {
    const idTokenHint = getCookie(c, LOGOUT_HINT_COOKIE);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    deleteCookie(c, LOGOUT_HINT_COOKIE, { path: LOGOUT_PATH });
    // A same-origin `returnTo` lets a "sign out and use another account" flow land
    // back where it started (e.g. an invite link) so the next login is scoped to it.
    const local = safePath(c.req.query('returnTo')) ?? onSuccess;
    // `?federated` also ends the IdP's own SSO session (RP-initiated logout) — without
    // it the IdP cookie silently signs the same user straight back in, so "use another
    // account" never works. Opt-in per link: a plain logout stays local (other apps on
    // the shared IdP session keep theirs). Requires the origin to be registered as an
    // allowed logout URL on the IdP client; discovery failure falls back to local.
    if (c.req.query('federated') !== undefined) {
      try {
        const d = await discover(c.env.OIDC_ISSUER);
        if (d.end_session_endpoint) {
          const u = new URL(d.end_session_endpoint);
          u.searchParams.set('client_id', c.env.OIDC_CLIENT_ID);
          u.searchParams.set('post_logout_redirect_uri', `${new URL(c.req.url).origin}${local}`);
          // The ID token from this login, handed back per OIDC RP-Initiated Logout §2.
          // Without it the OP cannot tell a real sign-out from a link someone was
          // tricked into following, so it SHOULD (and Better Auth's provider does)
          // interrupt with a "Confirm logout" page — an interstitial in the middle of
          // what the person already asked for. With it the OP verifies the request
          // against the session the hint names and redirects straight through.
          // Absent for a session minted before this version: the confirmation page is
          // then still correct, and the next login puts the hint back.
          //
          // And absent over plaintext. The hint is a signed assertion about who is
          // signed in, travelling in a URL the browser will also put in history and
          // `Referer`; an issuer advertising an `http:` end-session endpoint would have
          // it read off the wire. Loopback is exempt because that is `dev-issuer`, which
          // every demo's local login uses. The redirect itself still happens — it
          // carries no secret, and refusing it would change what a plaintext issuer did
          // before this feature existed — so the person is signed out either way and the
          // OP falls back to asking them to confirm.
          if (idTokenHint) {
            if (isHttpsOrLoopback(u)) u.searchParams.set('id_token_hint', idTokenHint);
            else console.warn('oidc.logout.hint_withheld', { reason: 'end_session_endpoint is not https' });
          }
          return c.redirect(u.toString());
        }
      } catch (err) {
        console.error('oidc.logout.discovery_failed', { reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return c.redirect(local);
  });
}
