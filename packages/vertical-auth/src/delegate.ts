/**
 * The MASTER's half of a delegated peer call (#3161): a token that lets one of its plugins take a
 * call as the person signed in here, obtained at the team issuer by RFC 8693 token exchange on
 * the `peer` channel (`delegations.ts` in contracts).
 *
 * Two requests to the issuer's token endpoint, both authenticated as this app's own client the
 * way its sign-in authenticates (`client_secret_post` unless told otherwise, as
 * `@substrat-run/oidc-rp`'s code exchange does):
 *
 *  1. **Refresh.** The exchange takes a LIVE token of the person, and the one from sign-in is long
 *     expired by the time a call is made, so the session's refresh token (kept server-side under
 *     its `sid`, `./session-refresh`) buys a fresh `id_token`. A rotated refresh token that comes
 *     back replaces the stored one.
 *  2. **Exchange.** The `id_token` is traded for an access token whose `aud` is the plugin's client
 *     id and whose `scope` is at most what the platform granted this app there.
 *
 * Both answers are kept in the isolate until 30 s before they expire, so a call in that window
 * costs no issuer request (and writes no token rows there), and a second audience or scope costs
 * one exchange and no refresh. The cost: a token the issuer revokes stays usable from here for
 * what is left of its lifetime, at most 5 minutes for a delegated token — the bound the plugin
 * already accepts by not asking the issuer about each one. A kept `id_token` is still judged by
 * the issuer at every exchange; only a revoked REFRESH token goes unnoticed until the next refresh.
 * Nothing kept outlives the session's row: a hit reads it, so a logout (or a `reauth` in another
 * isolate) ends every use of the tokens kept for that session.
 *
 * Nothing here logs, and no error carries a token: a failure says which step and the OAuth error
 * code, never what was sent.
 *
 * workerd-safe: Web APIs, `jose`'s decoder, and oidc-rp's discovery subpath.
 */
import { decodeJwt } from 'jose';
import { TOKEN_EXCHANGE_GRANT_TYPE, TOKEN_TYPE } from '@substrat-run/contracts';
import type { ConnectorRequestInit, FetchLike } from '@substrat-run/kernel';
import { discoverIssuer } from '@substrat-run/oidc-rp/discovery';
import { DELEGATED_TOKEN_MAX_LIFETIME_SECONDS } from './oidc.js';
import type { RefreshStore } from './session-refresh.js';

export interface DelegatedTokenDeps {
  /** The issuer this app signs people in at — the team auth-server. */
  issuer: string;
  /** This app's own OIDC client: the actor the token names. */
  clientId: string;
  clientSecret: string;
  /** How the client authenticates at the token endpoint, as registered. Defaults to `client_secret_post`. */
  tokenEndpointAuth?: 'client_secret_basic' | 'client_secret_post';
  store: RefreshStore;
  /** `globalFetch` from `@substrat-run/kernel` in a worker. Called as a plain function. */
  fetch: FetchLike;
  now?: () => Date;
}

export interface DelegatedTokenRequest {
  /** The session's id: `AuthSubject.sid` of the person this app is acting for. */
  sid: string;
  /** The plugin's OIDC client id (its answer to `PEER_CLIENT_OPERATION`). */
  audience: string;
  /** The plugin's permission keys to ask for. Absent asks for everything granted. */
  scope?: readonly string[];
}

export interface DelegatedToken {
  /** The access token, for `peerCallRequest.onBehalf.token`. */
  token: string;
  /** What the issuer granted: the keys the plugin will cap the call to. */
  scope: string[];
  /** ISO 8601. */
  expiresAt: string;
}

/**
 * Why no token was obtained, in three kinds a caller acts on differently:
 *
 *  - **`reauth`**: the session keeps no usable refresh token (none was kept, or the issuer refused
 *    it as expired or revoked, and the stored row is gone). The person must sign in again.
 *  - **`refused`**: the issuer answered with an OAuth error other than that — at the `exchange`,
 *    typically `unauthorized_client` or `invalid_target` when the platform grants this app no
 *    `peer` delegation to that plugin, or `invalid_scope`. `code` is the issuer's error code.
 *  - **`unavailable`**: the issuer could not be reached, failed, or answered something that is
 *    not the protocol. Retrying later may work.
 */
export class DelegatedTokenError extends Error {
  constructor(
    readonly kind: 'reauth' | 'refused' | 'unavailable',
    readonly step: 'refresh' | 'exchange',
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'DelegatedTokenError';
  }
}

/**
 * Refreshes in flight, per issuer, client and session. Two calls for one session at once share
 * one refresh: the issuer rotates the token, and the second request presenting the one just
 * spent is a REUSE, which an issuer following RFC 9700 §4.14 (Better Auth does) answers by
 * revoking every refresh token of that person at this client. This holds within an isolate only.
 */
const refreshing = new Map<string, Promise<FreshIdToken>>();

/** A kept token is handed out until this long before it expires, so a call made with it lands in time. */
const EXPIRY_MARGIN_MS = 30_000;

interface SessionTokens {
  idToken: { token: string; until: number } | null;
  /** Keyed by audience and the sorted scope asked for. */
  delegated: Map<string, { token: DelegatedToken; until: number }>;
}

/** Tokens obtained, per issuer, client and session, within an isolate. Cleared, never grown, past a bound. */
const kept = new Map<string, SessionTokens>();
const MAX_SESSIONS = 1_000;
const MAX_DELEGATED_PER_SESSION = 32;

function keepFor(key: string): SessionTokens {
  let session = kept.get(key);
  if (!session) {
    if (kept.size >= MAX_SESSIONS) kept.clear();
    session = { idToken: null, delegated: new Map() };
    kept.set(key, session);
  }
  return session;
}

/** A delegated access token for `request.audience`, as the person whose session is `request.sid`. */
export async function delegatedToken(deps: DelegatedTokenDeps, request: DelegatedTokenRequest): Promise<DelegatedToken> {
  const clock = () => (deps.now ?? (() => new Date()))().getTime();
  const key = JSON.stringify([deps.issuer, deps.clientId, request.sid]);
  const target = JSON.stringify([request.audience, [...new Set(request.scope ?? [])].sort()]);

  let session = kept.get(key);
  // A logout, or a reauth in another isolate, deletes the row: nothing kept for it is used after.
  if (session && !(await deps.store.get(request.sid))) {
    kept.delete(key);
    session = undefined;
  }
  const hit = session?.delegated.get(target);
  if (hit && clock() < hit.until) return { ...hit.token, scope: [...hit.token.scope] };

  let tokenEndpoint: string;
  try {
    tokenEndpoint = (await discoverIssuer(deps.issuer)).token_endpoint;
  } catch {
    throw new DelegatedTokenError('unavailable', 'refresh', null, 'delegated token: the issuer could not be discovered');
  }
  if (typeof tokenEndpoint !== 'string') {
    throw new DelegatedTokenError('unavailable', 'refresh', null, 'delegated token: the issuer names no token endpoint');
  }

  const keptIdToken = session?.idToken;
  let idToken: string;
  if (keptIdToken && clock() < keptIdToken.until) {
    idToken = keptIdToken.token;
  } else {
    let pending = refreshing.get(key);
    if (!pending) {
      pending = freshIdToken(deps, tokenEndpoint, request.sid).finally(() => refreshing.delete(key));
      refreshing.set(key, pending);
    }
    let fresh: FreshIdToken;
    try {
      fresh = await pending;
    } catch (err) {
      if (err instanceof DelegatedTokenError && err.kind === 'reauth') kept.delete(key);
      throw err;
    }
    idToken = fresh.token;
    if (fresh.expiresAt !== null) keepFor(key).idToken = { token: fresh.token, until: fresh.expiresAt - EXPIRY_MARGIN_MS };
  }

  const answer = await post(deps, tokenEndpoint, 'exchange', {
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    subject_token: idToken,
    subject_token_type: TOKEN_TYPE.idToken,
    requested_token_type: TOKEN_TYPE.accessToken,
    audience: request.audience,
    ...(request.scope && request.scope.length > 0 ? { scope: request.scope.join(' ') } : {}),
  });
  if (!answer.ok) {
    // RFC 8693 §2.2.2: the subject token itself was refused, so the kept one is no good either.
    if (answer.code === 'invalid_grant') {
      const current = kept.get(key);
      if (current) current.idToken = null;
    }
    throw new DelegatedTokenError('refused', 'exchange', answer.code, `delegated token: the exchange was refused (${answer.code})`);
  }
  const body = answer.body;
  const token = body['access_token'];
  const issuedType = body['issued_token_type'];
  const tokenType = body['token_type'];
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    issuedType !== TOKEN_TYPE.accessToken ||
    typeof tokenType !== 'string' ||
    tokenType.toLowerCase() !== 'bearer'
  ) {
    throw new DelegatedTokenError('unavailable', 'exchange', null, 'delegated token: the exchange answered without a bearer access token');
  }
  // RFC 8693 §2.2.1: `scope` may be left out when it is what was asked for.
  const granted = typeof body['scope'] === 'string' ? body['scope'] : (request.scope ?? []).join(' ');
  // Never later than the verifier's own bound: a longer claim would only mislead the caller.
  const expiresIn = typeof body['expires_in'] === 'number' && body['expires_in'] > 0 ? body['expires_in'] : DELEGATED_TOKEN_MAX_LIFETIME_SECONDS;
  const expiresAt = clock() + Math.min(expiresIn, DELEGATED_TOKEN_MAX_LIFETIME_SECONDS) * 1000;
  const result: DelegatedToken = {
    token,
    scope: [...new Set(granted.split(' ').filter((s) => s.length > 0))],
    expiresAt: new Date(expiresAt).toISOString(),
  };
  const delegated = keepFor(key).delegated;
  if (delegated.size >= MAX_DELEGATED_PER_SESSION) delegated.clear();
  delegated.set(target, { token: result, until: expiresAt - EXPIRY_MARGIN_MS });
  return { ...result, scope: [...result.scope] };
}

interface FreshIdToken {
  token: string;
  /** Epoch ms of its `exp`; `null` when it states none, and then it is not kept. */
  expiresAt: number | null;
}

/**
 * A fresh `id_token` of the session's person, from its refresh token. A refusal of the refresh
 * token itself (`invalid_grant`: expired, revoked, already spent) deletes the row and is
 * `reauth` — unless the row changed meanwhile, which is another refresh having rotated it, and
 * that newer token is tried once first.
 */
async function freshIdToken(deps: DelegatedTokenDeps, tokenEndpoint: string, sid: string): Promise<FreshIdToken> {
  for (let attempt = 0; ; attempt++) {
    const held = await deps.store.get(sid);
    if (!held) throw new DelegatedTokenError('reauth', 'refresh', null, 'delegated token: this session keeps no refresh token');
    const answer = await post(deps, tokenEndpoint, 'refresh', { grant_type: 'refresh_token', refresh_token: held.refreshToken });
    if (!answer.ok) {
      if (answer.code !== 'invalid_grant') {
        throw new DelegatedTokenError('refused', 'refresh', answer.code, `delegated token: the refresh was refused (${answer.code})`);
      }
      const now = await deps.store.get(sid);
      if (attempt === 0 && now && now.refreshToken !== held.refreshToken) continue;
      await deps.store.delete(sid);
      throw new DelegatedTokenError('reauth', 'refresh', answer.code, 'delegated token: the refresh token was refused');
    }

    const idToken = answer.body['id_token'];
    if (typeof idToken !== 'string' || idToken.length === 0) {
      throw new DelegatedTokenError('unavailable', 'refresh', null, 'delegated token: the refresh answered without an id_token');
    }
    const rotated = answer.body['refresh_token'];
    if (typeof rotated === 'string' && rotated.length > 0 && rotated !== held.refreshToken) {
      try {
        await deps.store.put(sid, { sub: held.sub, refreshToken: rotated });
      } catch {
        // The row still holds the token just spent, and presenting that again is a reuse, which
        // revokes every refresh token the person has. Forget it, so the next call is a clean
        // reauth; the id_token is live and the person's, so this call still goes ahead with it.
        try {
          await deps.store.delete(sid);
        } catch {
          throw new DelegatedTokenError('unavailable', 'refresh', null, 'delegated token: the rotated refresh token could not be kept');
        }
      }
    }
    // Read, not verified: it came straight from the token endpoint over TLS (OIDC Core §3.1.3.7),
    // and the issuer verifies it again as the subject token. This only catches a row that names
    // someone other than the person the token is for, which must never be acted for.
    let sub: unknown;
    let exp: unknown;
    try {
      ({ sub, exp } = decodeJwt(idToken));
    } catch {
      throw new DelegatedTokenError('unavailable', 'refresh', null, 'delegated token: the refresh answered an unreadable id_token');
    }
    if (sub !== held.sub) {
      await deps.store.delete(sid);
      throw new DelegatedTokenError('reauth', 'refresh', null, "delegated token: the refreshed token is not the session's person");
    }
    return { token: idToken, expiresAt: typeof exp === 'number' ? exp * 1000 : null };
  }
}

type Answer = { ok: true; body: Record<string, unknown> } | { ok: false; code: string };

/**
 * POST a form to the token endpoint as this client. A 4xx with an OAuth error body is the
 * issuer's refusal; anything else that is not a 2xx JSON object is `unavailable`.
 */
async function post(
  deps: DelegatedTokenDeps,
  tokenEndpoint: string,
  step: 'refresh' | 'exchange',
  form: Record<string, string>,
): Promise<Answer> {
  const basic = deps.tokenEndpointAuth === 'client_secret_basic';
  // `redirect` is not on `FetchLike`'s init, so it rides a variable; the runtime's fetch reads it.
  // Manual, as the sign-in's code exchange does: a redirect would re-send the secret elsewhere.
  const init: ConnectorRequestInit & { redirect: 'manual' } = {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      // RFC 6749 §2.3.1: the id and the secret are form-urlencoded FIRST, then joined and base64'd.
      ...(basic ? { authorization: `Basic ${btoa(`${encodeURIComponent(deps.clientId)}:${encodeURIComponent(deps.clientSecret)}`)}` } : {}),
    },
    body: new URLSearchParams({
      ...form,
      client_id: deps.clientId,
      // Never both: an issuer may refuse a request that presents the secret twice.
      ...(basic ? {} : { client_secret: deps.clientSecret }),
    }).toString(),
  };
  const send = deps.fetch;
  let res: Awaited<ReturnType<FetchLike>>;
  let body: unknown;
  try {
    res = await send(tokenEndpoint, init);
    body = await res.json().catch(() => null);
  } catch {
    throw new DelegatedTokenError('unavailable', step, null, `delegated token: the issuer could not be reached (${step})`);
  }
  const object = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (res.ok && object) return { ok: true, body: object };
  if (res.status >= 400 && res.status < 500 && object && typeof object['error'] === 'string') return { ok: false, code: object['error'] };
  throw new DelegatedTokenError('unavailable', step, null, `delegated token: the issuer answered ${res.status} (${step})`);
}
