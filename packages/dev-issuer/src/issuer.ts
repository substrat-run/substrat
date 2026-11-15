/**
 * A real OpenID Connect provider, with exactly one shortcut: `/authorize` shows a list of
 * names and returns as soon as you click one, instead of asking for a password.
 *
 * Everything else is the genuine protocol — discovery, JWKS, Authorization Code + PKCE, a
 * signed ID token with `nonce` — because the point is that the app talking to it runs its
 * PRODUCTION login path. A vertical wired to this issuer holds no dev branch, no
 * impersonation header and no persona list: it is an ordinary relying party, and swapping
 * this issuer for a real one is a config change. That is the whole design.
 *
 * **Stateless.** There is no session store, no code store, and no issuer cookie. An
 * authorization code IS a short-lived JWT carrying everything `/token` must check
 * (subject, client, redirect URI, nonce, PKCE challenge), signed with the key in
 * `keys.ts`. Two consequences worth knowing:
 *
 *   - Restarting the issuer invalidates nothing, so a dev server and a test script can
 *     restart independently of each other.
 *   - Having no SSO session, the picker appears on EVERY `/authorize` — which is what you
 *     want from a dev issuer. Switching user is one click, not a logout dance, and
 *     `prompt=select_account` (what the platform's RP sends for "use another account")
 *     needs no special handling because it is already the only behaviour.
 *
 * The same holds for the two grants a master app needs to call its plugin as the signed-in
 * person (#3161): a refresh token is a JWT too, and the peer token exchange reads its grants
 * from an option rather than a registry.
 *
 * Never deploy this. The signing key is checked in — see `keys.ts`.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  PROBLEM_CONTENT_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
  TOKEN_TYPE,
  channelsOf,
  substratError,
  toProblem,
  type DelegationChannel,
} from '@substrat-run/contracts';
import { SignJWT, jwtVerify, importJWK, type JWTPayload } from 'jose';
import { DEV_ALG, DEV_KID, DEV_PRIVATE_JWK, DEV_PUBLIC_JWK } from './keys.js';
import type { DevPersona } from './personas.js';

/**
 * The client id `devLogin` signs in as unless told otherwise, and so the audience
 * `/dev/token` mints for by default: a script's token is the harness's own (#1683).
 */
export const DEV_CLIENT_ID = 'substrat-dev';

export interface DevIssuerOptions {
  /** The cast the picker offers. The `sub` values are the contract with the app's directory. */
  personas: DevPersona[];
  /**
   * Pin the `issuer` value instead of deriving it from the request's own origin.
   * Leave unset: derived means discovery is always self-consistent with whatever host
   * the relying party actually reached, which is what a local RP needs.
   */
  issuer?: string;
  /** ID/access token lifetime in seconds (default 1 hour). */
  tokenTtlSec?: number;
  /**
   * Extra redirect-URI prefixes to accept beyond loopback. Loopback (`http://localhost:*`,
   * `http://127.0.0.1:*`, `http://[::1]:*`) is always accepted; anything else is refused so a
   * stray instance cannot be pointed at a third-party URL and used as an open redirector.
   */
  allowedRedirectPrefixes?: string[];
  /**
   * Which app may act for which other app's people through the peer token exchange (#3161),
   * the local stand-in for the platform's delegation grants (`delegationGrant` in contracts).
   * Keyed by CLIENT id, where the team auth-server keys them by app scope: locally there is no
   * place registry to say which app a client is, so the client id stands for its app. `host`
   * is the app called, `actor` the one calling it as the person. A grant read through
   * `channelsOf`, so one naming no channel is `mcp` alone, and only `peer` is served here.
   * Absent, every exchange is refused.
   */
  delegations?: DevDelegation[];
}

/** One grant of {@link DevIssuerOptions.delegations}. */
export interface DevDelegation {
  host: string;
  actor: string;
  permissions: string[];
  channels?: DelegationChannel[];
}

const CODE_TTL_SEC = 300;

/** How long a refresh token lives: thirty days, as long as a laptop stays signed in. */
const REFRESH_TTL_SEC = 30 * 24 * 3600;

/**
 * The second `aud` of a refresh token. With it the audience is multi-valued and names a URN,
 * so no relying party takes a refresh token as an id_token or a bearer (the trick the team
 * auth-server's delegation assertion uses); it also carries no `iss`, like a code, so no
 * issuer-checking verifier, `/userinfo` included, gets as far as its audience.
 */
const REFRESH_AUDIENCE = 'urn:substrat:dev-issuer:refresh-token';

/**
 * How long a token the peer exchange mints lives. Equal to the team auth-server's
 * `EXCHANGED_TOKEN_TTL_SECONDS` and to vertical-auth's `DELEGATED_TOKEN_MAX_LIFETIME_SECONDS`,
 * which refuses a longer one: keep the three equal.
 */
const EXCHANGED_TOKEN_TTL_SEC = 300;

/** The subject token types the peer exchange accepts: a JWT this issuer signed for the caller. */
const SUBJECT_TYPES: ReadonlySet<string> = new Set([TOKEN_TYPE.idToken, TOKEN_TYPE.jwt, TOKEN_TYPE.accessToken]);

/** A parsed `/authorize` request — everything the code must carry to `/token`. */
interface AuthzRequest {
  clientId: string;
  redirectUri: string;
  state: string | undefined;
  nonce: string | undefined;
  codeChallenge: string | undefined;
  scope: string;
  prompt: string | undefined;
  loginHint: string | undefined;
}

/**
 * Sign with the private half, verify with the public one. They are separate imports on
 * purpose: a WebCrypto key carries its allowed operations, so the private key imported for
 * `sign` cannot verify — which is what made the authorization code, verified here on its way
 * back in, fail against itself.
 */
type ImportedKey = Awaited<ReturnType<typeof importJWK>>;
let cachedPrivate: Promise<ImportedKey> | undefined;
let cachedPublic: Promise<ImportedKey> | undefined;
function signingKey(): Promise<ImportedKey> {
  cachedPrivate ??= importJWK(DEV_PRIVATE_JWK, DEV_ALG);
  return cachedPrivate;
}
function verificationKey(): Promise<ImportedKey> {
  cachedPublic ??= importJWK(DEV_PUBLIC_JWK, DEV_ALG);
  return cachedPublic;
}

const enc = new TextEncoder();
const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function sign(claims: JWTPayload, ttlSec: number): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: DEV_ALG, kid: DEV_KID, typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(await signingKey());
}

/** Loopback always; anything else only if explicitly allowed. */
function redirectAllowed(uri: string, extra: string[]): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  const loopback =
    u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1');
  return loopback || extra.some((p) => uri.startsWith(p));
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Send the browser back to the relying party with an OAuth error, per RFC 6749 §4.1.2.1 —
 * but only once the redirect URI is known to be safe. Before that point the only correct
 * answer is a plain response, because redirecting is exactly what we have not yet validated.
 */
function redirectError(c: Context, redirectUri: string, state: string | undefined, error: string, description: string) {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  u.searchParams.set('error_description', description);
  if (state) u.searchParams.set('state', state);
  return c.redirect(u.toString());
}

/** A non-OAuth refusal, as the RFC 9457 problem document every Substrat surface answers with. */
function problem(
  c: Context,
  code: 'unauthenticated' | 'validation_failed',
  detail: string,
  headers: Record<string, string> = {},
) {
  const body = toProblem(substratError(code, detail), c.req.path);
  return c.body(JSON.stringify(body), body.status as 400 | 401, { ...headers, 'content-type': PROBLEM_CONTENT_TYPE });
}

export function createDevIssuer(opts: DevIssuerOptions): Hono {
  const personas = opts.personas;
  const ttl = opts.tokenTtlSec ?? 3600;
  const extraRedirects = opts.allowedRedirectPrefixes ?? [];
  const delegations = opts.delegations ?? [];
  // Which of two grants for one pair would win is not a question to answer by accident.
  const pairs = new Set(delegations.map((d) => JSON.stringify([d.host, d.actor])));
  if (pairs.size !== delegations.length) throw new Error('dev issuer: a delegation names the same host and actor twice');
  const app = new Hono();

  const issuerOf = (c: Context): string => opts.issuer ?? new URL(c.req.url).origin;
  const personaOf = (sub: string): DevPersona | undefined => personas.find((p) => p.sub === sub);

  const claimsFor = (p: DevPersona) => ({
    sub: p.sub,
    name: p.name,
    email: p.email,
    email_verified: true,
  });

  // ── Discovery ──────────────────────────────────────────────────────────────────────
  app.get('/.well-known/openid-configuration', (c) => {
    const issuer = issuerOf(c);
    return c.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks.json`,
      userinfo_endpoint: `${issuer}/userinfo`,
      end_session_endpoint: `${issuer}/logout`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token', TOKEN_EXCHANGE_GRANT_TYPE],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: [DEV_ALG],
      scopes_supported: ['openid', 'email', 'profile', 'offline_access'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      code_challenge_methods_supported: ['S256'],
      claims_supported: ['sub', 'name', 'email', 'email_verified', 'nonce', 'aud', 'exp', 'iat', 'iss'],
    });
  });

  app.get('/jwks.json', (c) => c.json({ keys: [DEV_PUBLIC_JWK] }));

  // ── Authorization ──────────────────────────────────────────────────────────────────
  /**
   * One endpoint, two states: without `sub` it renders the picker, with a known `sub` it
   * issues the code. The picker's links carry the original query string back verbatim plus
   * the chosen `sub`, so nothing about the request needs to be remembered between them —
   * which is what lets the issuer keep no state at all.
   */
  app.get('/authorize', async (c) => {
    const q = c.req.query();
    const redirectUri = q.redirect_uri ?? '';
    // Validate the redirect target FIRST: every other error is reported by redirecting to
    // it, and an unvalidated redirect is the one thing that must never happen.
    if (!redirectUri) return c.text('missing redirect_uri', 400);
    if (!redirectAllowed(redirectUri, extraRedirects)) {
      return c.text(
        `refusing to redirect to ${redirectUri} — the dev issuer accepts loopback URIs only ` +
          '(pass allowedRedirectPrefixes to widen it)',
        400,
      );
    }

    const req: AuthzRequest = {
      clientId: q.client_id ?? '',
      redirectUri,
      state: q.state,
      nonce: q.nonce,
      codeChallenge: q.code_challenge,
      scope: q.scope ?? 'openid',
      prompt: q.prompt,
      loginHint: q.login_hint,
    };

    if (!req.clientId) return redirectError(c, redirectUri, req.state, 'invalid_request', 'missing client_id');
    if ((q.response_type ?? '') !== 'code') {
      return redirectError(c, redirectUri, req.state, 'unsupported_response_type', 'only response_type=code is supported');
    }
    if (q.code_challenge && (q.code_challenge_method ?? 'plain') !== 'S256') {
      return redirectError(c, redirectUri, req.state, 'invalid_request', 'only code_challenge_method=S256 is supported');
    }
    // No SSO session exists here by design, so `prompt=none` can only ever fail — and
    // saying so is more useful than silently showing the picker it asked us not to.
    if (req.prompt === 'none') {
      return redirectError(c, redirectUri, req.state, 'login_required', 'the dev issuer holds no session; a user must be picked');
    }

    const sub = q.sub;
    if (!sub) return c.html(pickerPage(req, personas, issuerOf(c)));
    const persona = personaOf(sub);
    if (!persona) return c.html(pickerPage(req, personas, issuerOf(c), `Unknown user "${sub}".`), 400);

    const code = await sign(
      {
        typ: 'code',
        sub: persona.sub,
        cid: req.clientId,
        ru: req.redirectUri,
        ...(req.nonce ? { n: req.nonce } : {}),
        ...(req.codeChallenge ? { cc: req.codeChallenge } : {}),
        ...(req.scope.split(' ').includes('offline_access') ? { oa: true } : {}),
      },
      CODE_TTL_SEC,
    );
    const back = new URL(req.redirectUri);
    back.searchParams.set('code', code);
    if (req.state) back.searchParams.set('state', req.state);
    return c.redirect(back.toString());
  });

  // ── Token ──────────────────────────────────────────────────────────────────────────
  /**
   * The client secret is accepted and NOT checked. A dev issuer that registered no clients
   * has no secret to compare against, and pretending otherwise would only mean inventing a
   * registration step — the friction this exists to remove. PKCE *is* checked, because it
   * is what binds the exchange to the browser that began it and the RP always sends it.
   *
   * Three grants: the code, a refresh token (when the code was issued for `offline_access`),
   * and the peer token exchange. The last two take `client_id` as the caller's identity, with
   * no secret behind it, for the same reason.
   */
  app.post('/token', async (c) => {
    const form = await c.req.parseBody();
    const str = (k: string): string => (typeof form[k] === 'string' ? (form[k] as string) : '');
    const fail = (error: string, description: string, status: 400 | 401 = 400) =>
      c.json({ error, error_description: description }, status);

    if (str('grant_type') === 'refresh_token') return refreshGrant(c, str, fail);
    if (str('grant_type') === TOKEN_EXCHANGE_GRANT_TYPE) return peerExchange(c, str, fail);
    if (str('grant_type') !== 'authorization_code') {
      return fail('unsupported_grant_type', 'only authorization_code, refresh_token and token exchange are supported');
    }
    const code = str('code');
    if (!code) return fail('invalid_request', 'missing code');

    let payload: JWTPayload & { typ?: string; cid?: string; ru?: string; n?: string; cc?: string; oa?: boolean };
    try {
      payload = (await jwtVerify(code, await verificationKey())).payload;
    } catch {
      return fail('invalid_grant', 'the authorization code is invalid or has expired');
    }
    if (payload.typ !== 'code') return fail('invalid_grant', 'not an authorization code');
    if (payload.cid !== str('client_id')) return fail('invalid_grant', 'client_id does not match the code');
    if (payload.ru !== str('redirect_uri')) return fail('invalid_grant', 'redirect_uri does not match the code');

    if (payload.cc) {
      const verifier = str('code_verifier');
      if (!verifier) return fail('invalid_grant', 'missing code_verifier');
      const challenge = b64url(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
      if (challenge !== payload.cc) return fail('invalid_grant', 'PKCE verification failed');
    }

    const persona = personaOf(String(payload.sub));
    if (!persona) return fail('invalid_grant', 'the code names a user this issuer no longer serves');

    const issuer = issuerOf(c);
    const base = { iss: issuer, aud: payload.cid, ...claimsFor(persona) };
    const [idToken, accessToken] = await Promise.all([
      sign({ ...base, ...(payload.n ? { nonce: payload.n } : {}) }, ttl),
      sign({ ...base, typ: 'access' }, ttl),
    ]);
    if (payload.oa) {
      return c.json({
        token_type: 'Bearer',
        expires_in: ttl,
        id_token: idToken,
        access_token: accessToken,
        refresh_token: await refreshTokenFor(persona.sub, String(payload.cid)),
        scope: 'openid email profile offline_access',
      });
    }
    return c.json({ token_type: 'Bearer', expires_in: ttl, id_token: idToken, access_token: accessToken, scope: 'openid email profile' });
  });

  type Str = (k: string) => string;
  type Fail = (error: string, description: string, status?: 400 | 401) => Response;

  /** A refresh token: the person and the client, and nothing a relying party would accept. */
  const refreshTokenFor = (sub: string, clientId: string) =>
    sign({ typ: 'refresh', sub, cid: clientId, aud: [clientId, REFRESH_AUDIENCE] }, REFRESH_TTL_SEC);

  /**
   * `grant_type=refresh_token`: a fresh id_token and access token for the client the refresh
   * token was issued to, with the claims the code exchange gives (no `nonce`: there is no
   * authorization request to bind it to), and a new refresh token. The person is re-read, so a
   * persona dropped from the cast cannot be refreshed.
   */
  async function refreshGrant(c: Context, str: Str, fail: Fail) {
    const token = str('refresh_token');
    if (!token) return fail('invalid_request', 'missing refresh_token');
    if (!str('client_id')) return fail('invalid_request', 'missing client_id');
    // The marker audience is what makes it a refresh token: a code carries the same `cid` and
    // `sub`, and must not be redeemable here without its PKCE verifier.
    let payload: JWTPayload & { cid?: string };
    try {
      payload = (await jwtVerify(token, await verificationKey(), { audience: REFRESH_AUDIENCE })).payload;
    } catch {
      return fail('invalid_grant', 'the refresh token is invalid or has expired');
    }
    if (payload.cid !== str('client_id')) return fail('invalid_grant', 'client_id does not match the refresh token');
    const persona = personaOf(String(payload.sub));
    if (!persona) return fail('invalid_grant', 'the refresh token names a user this issuer no longer serves');
    const base = { iss: issuerOf(c), aud: payload.cid, ...claimsFor(persona) };
    const [idToken, accessToken, refreshToken] = await Promise.all([
      sign(base, ttl),
      sign({ ...base, typ: 'access' }, ttl),
      refreshTokenFor(persona.sub, payload.cid),
    ]);
    return c.json({
      token_type: 'Bearer',
      expires_in: ttl,
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
      scope: 'openid email profile offline_access',
    });
  }

  /**
   * RFC 8693 token exchange, the `peer` channel only (#3161): the ACTOR presents a live token
   * this issuer signed for it, names the HOST's client id as `audience`, and asks for an access
   * token; it gets one with the person as `sub`, the host as `aud`, the actor as `azp` and in
   * `act`, and the granted keys as `scope`. The same semantics as the team auth-server's
   * exchange C (`demos/auth-server/src/token-exchange.ts`), so a master app calling its plugin
   * locally runs the round-trip it runs hosted. `client_id` names the actor and is not
   * authenticated: there is no secret to check it against (see above). The `mcp` channel's two
   * steps are not served here.
   */
  async function peerExchange(c: Context, str: Str, fail: Fail) {
    // Every value of a name, where a repeat must be seen rather than collapsed (`audience`).
    const repeated = await c.req.parseBody({ all: true });
    const all = (k: string): string[] => [repeated[k] ?? []].flat().filter((v): v is string => typeof v === 'string');
    const actor = str('client_id');
    if (!actor) return fail('invalid_request', 'client_id is required');
    if (str('requested_token_type') !== TOKEN_TYPE.accessToken) {
      return fail('invalid_request', `this issuer exchanges only for ${TOKEN_TYPE.accessToken} (the peer channel)`);
    }
    const subjectToken = str('subject_token');
    if (!subjectToken || !SUBJECT_TYPES.has(str('subject_token_type'))) {
      return fail('invalid_request', 'subject_token and a supported subject_token_type are required');
    }
    if (str('actor_token') || str('actor_token_type')) return fail('invalid_request', 'actor_token is not supported');
    if (all('resource').length > 0) return fail('invalid_request', 'this exchange takes an audience, not a resource');
    const audiences = all('audience');
    if (audiences.length !== 1 || !audiences[0]) return fail('invalid_request', 'exactly one audience is required');
    const host = audiences[0];

    const issuer = issuerOf(c);
    let subject: JWTPayload;
    try {
      subject = (await jwtVerify(subjectToken, await verificationKey(), { issuer })).payload;
    } catch {
      return fail('invalid_grant', 'the subject token is not a live token of this issuer');
    }
    if (!subject.sub) return fail('invalid_grant', 'the subject token is not a live token of this issuer');
    // No chaining: a token that is itself the product of an exchange is not a login.
    if (subject['act'] !== undefined || subject['substrat_delegation'] !== undefined) {
      return fail('invalid_grant', 'the subject token is already delegated');
    }
    // Issued to the actor and nobody else: every authorized party present is the actor, or
    // there is none and `aud` is the actor alone. Without this, an app could trade a token
    // another app was issued for the person.
    const parties = [subject['azp'], subject['client_id']].filter((p) => p !== undefined);
    const aud = subject.aud;
    const soleAud = typeof aud === 'string' ? aud : Array.isArray(aud) && aud.length === 1 ? aud[0] : undefined;
    const issuedToActor = parties.length > 0 ? parties.every((p) => p === actor) : soleAud === actor;
    if (!issuedToActor) return fail('invalid_grant', 'the subject token was not issued to this client');

    const grant = host === actor ? undefined : delegations.find((d) => d.host === host && d.actor === actor);
    if (!grant || !channelsOf(grant).includes('peer')) {
      return fail('invalid_target', `${host} does not delegate to this client`);
    }
    const requested = [...new Set(str('scope').split(' ').filter((s) => s.length > 0))];
    const scope = requested.length ? requested.filter((s) => grant.permissions.includes(s)) : [...new Set(grant.permissions)];
    if (scope.length === 0) return fail('invalid_scope', 'none of the requested scope is delegated');

    const email = typeof subject['email'] === 'string' ? { email: subject['email'] } : {};
    const verified = typeof subject['email_verified'] === 'boolean' ? { email_verified: subject['email_verified'] } : {};
    const token = await sign(
      {
        iss: issuer,
        sub: subject.sub,
        aud: host,
        azp: actor,
        client_id: actor,
        scope: scope.join(' '),
        act: { iss: issuer, sub: actor },
        // Client ids where the hosted issuer names app scopes: locally they are the apps.
        substrat_delegation: { stage: 'peer', host, actor },
        ...email,
        ...verified,
        jti: crypto.randomUUID(),
      },
      EXCHANGED_TOKEN_TTL_SEC,
    );
    return c.json({
      access_token: token,
      issued_token_type: TOKEN_TYPE.accessToken,
      token_type: 'Bearer',
      expires_in: EXCHANGED_TOKEN_TTL_SEC,
      scope: scope.join(' '),
    });
  }

  app.get('/userinfo', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '';
    // RFC 6750 §3: the refusal is announced in WWW-Authenticate; the body is a problem document.
    // §3.1: a request that carried no bearer gets the bare challenge, with no error code.
    const refuse = (challenge: string, detail: string) =>
      problem(c, 'unauthenticated', detail, { 'www-authenticate': challenge });
    const invalid = () => refuse('Bearer error="invalid_token"', 'the bearer token is invalid or has expired');
    if (!token) return refuse('Bearer', 'no bearer token was presented');
    try {
      const { payload } = await jwtVerify(token, await verificationKey(), { issuer: issuerOf(c) });
      const persona = personaOf(String(payload.sub));
      if (!persona) return invalid();
      return c.json(claimsFor(persona));
    } catch {
      return invalid();
    }
  });

  /**
   * RP-initiated logout. There is no issuer session to end — the picker always asks — so
   * this only honours `post_logout_redirect_uri`, which is what makes the relying party's
   * `?federated` logout land somewhere sensible instead of erroring.
   */
  app.get('/logout', (c) => {
    const to = c.req.query('post_logout_redirect_uri');
    if (to && redirectAllowed(to, extraRedirects)) return c.redirect(to);
    return c.html(signedOutPage());
  });

  // ── The non-interactive door ───────────────────────────────────────────────────────
  /**
   * Mint tokens for a persona with no browser — the escape hatch a test, a curl, or a
   * headless verification script needs.
   *
   * This IS impersonation, and putting it here is the point: it lives in a process that
   * binds to localhost and is never deployed, rather than behind a flag in the vertical,
   * where the same capability ships to production and only an environment variable stands
   * between it and a cross-tenant hole.
   */
  app.post('/dev/token', async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const sub = typeof body.sub === 'string' ? body.sub : '';
    // The default audience is the client `devLogin` signs in as, so a minted token is one
    // the harness accepts as its OWN, the way a hosted vertical on a team auth-server
    // accepts only its own (#1683). An MCP client's token passes its endpoint's URL instead.
    const audience = typeof body.audience === 'string' ? body.audience : DEV_CLIENT_ID;
    const persona = personaOf(sub);
    if (!persona) {
      const known = personas.map((p) => p.sub).join(', ');
      return problem(c, 'validation_failed', `unknown sub '${sub}' — known: ${known}`);
    }
    const base = { iss: issuerOf(c), aud: audience, ...claimsFor(persona) };
    const [idToken, accessToken] = await Promise.all([sign(base, ttl), sign({ ...base, typ: 'access' }, ttl)]);
    return c.json({ token_type: 'Bearer', expires_in: ttl, id_token: idToken, access_token: accessToken });
  });

  /** The cast as JSON — what a script enumerates before minting. */
  app.get('/dev/personas', (c) => c.json(personas));

  return app;
}

// ── The picker ───────────────────────────────────────────────────────────────────────

/**
 * Server-rendered, no build step, no client JavaScript. Each entry is a plain link back to
 * `/authorize` carrying the original request plus `sub`, so picking a user is one GET and
 * the browser's own back button behaves.
 */
function pickerPage(req: AuthzRequest, personas: DevPersona[], issuer: string, error?: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: req.clientId,
    redirect_uri: req.redirectUri,
    scope: req.scope,
    ...(req.state ? { state: req.state } : {}),
    ...(req.nonce ? { nonce: req.nonce } : {}),
    ...(req.codeChallenge ? { code_challenge: req.codeChallenge, code_challenge_method: 'S256' } : {}),
  });
  const hinted = req.loginHint?.toLowerCase();
  const rows = personas
    .map((p) => {
      const href = `/authorize?${params.toString()}&sub=${encodeURIComponent(p.sub)}`;
      const match = hinted && p.email.toLowerCase() === hinted ? ' match' : '';
      return `<a class="who${match}" href="${escapeHtml(href)}">
        <span class="avatar">${escapeHtml([...p.name][0] ?? '?')}</span>
        <span class="lines">
          <strong>${escapeHtml(p.name)}</strong>
          <small>${escapeHtml(p.note ?? p.email)}</small>
        </span>
        <code>${escapeHtml(p.sub)}</code>
      </a>`;
    })
    .join('\n');
  return page(
    'Pick a user',
    `<h1>Sign in</h1>
     <p class="sub">Development issuer at <code>${escapeHtml(issuer)}</code> — pick who to be.
        <strong>${escapeHtml(req.clientId)}</strong> is asking.</p>
     ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
     <div class="list">${rows}</div>
     <p class="foot">No passwords: this issuer authenticates nobody. It exists so the app runs its real
        OIDC login locally. Never deploy it — its signing key is public.</p>`,
  );
}

function signedOutPage(): string {
  return page('Signed out', `<h1>Signed out</h1><p class="sub">You can close this tab.</p>`);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --fg:#14181f; --muted:#5b6472; --line:#e3e6ea; --accent:#3b5bdb; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14181f; --card:#1c2129; --fg:#e8ebef; --muted:#98a2b3; --line:#2b323c; --accent:#7d94f5; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg);
         font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; padding:32px 16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:28px; width:min(460px,100%); }
  h1 { margin:0 0 6px; font-size:20px; }
  .sub { margin:0 0 18px; color:var(--muted); font-size:13px; }
  .error { margin:0 0 14px; padding:8px 10px; border-radius:8px; background:#fdecec; color:#a02020; font-size:13px; }
  @media (prefers-color-scheme: dark) { .error { background:#3a1f22; color:#f5b5b5; } }
  .list { display:flex; flex-direction:column; gap:8px; }
  .who { display:flex; align-items:center; gap:12px; padding:10px 12px; border:1px solid var(--line); border-radius:10px;
         text-decoration:none; color:inherit; }
  .who:hover { border-color:var(--accent); background:color-mix(in srgb, var(--accent) 8%, transparent); }
  .who.match { border-color:var(--accent); }
  .avatar { flex:0 0 34px; height:34px; border-radius:50%; display:grid; place-items:center; font-weight:600;
            background:color-mix(in srgb, var(--accent) 16%, transparent); color:var(--accent); }
  .lines { display:flex; flex-direction:column; min-width:0; flex:1; }
  .lines small { color:var(--muted); font-size:12px; }
  code { font:12px ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); }
  .foot { margin:18px 0 0; color:var(--muted); font-size:12px; }
</style></head>
<body><div class="card">${body}</div></body></html>`;
}
