import { TOKEN_EXCHANGE_GRANT_TYPE, TOKEN_TYPE } from '@substrat-run/contracts';
import type { SqlExec } from './introspect.js';
import { grantFor } from './delegations.js';
import { authMethodOf, registrationOfClient } from './places.js';
import { platformOwnerOf } from './resources.js';

/**
 * RFC 8693 TOKEN EXCHANGE at this issuer (#1824): one app of a team acting for another app's
 * user, gated by the platform's delegation grant (`delegations.ts`).
 *
 * `@better-auth/oauth-provider` implements `authorization_code`, `client_credentials` and
 * `refresh_token` and nothing else, so this grant is ours. The worker sends a token-endpoint
 * POST whose `grant_type` is token exchange here (`routes.ts`), and every other grant to the
 * plugin untouched.
 *
 * ## Two exchanges, told apart by the subject token
 *
 *   A. **The host asks for an assertion addressed to the actor.** Authenticated as the host's
 *      client, it presents a token this issuer signed FOR it (the user's id_token, or an
 *      access token issued to it) and names the actor's client as `audience`. It gets a
 *      short-lived JWT for the actor: the user as `sub`, the host as `azp`, the actor as
 *      `aud`, and a `substrat_delegation` claim saying which apps it is between.
 *   B. **The actor trades that assertion for an access token for the host's MCP endpoint.**
 *      Authenticated as the actor's client, it presents the assertion and names one of the
 *      host's MCP resources as `resource` (RFC 8707). It gets an access token for that
 *      resource, with the user as `sub`, the actor as `azp` and in `act`, and a scope no wider
 *      than the grant.
 *
 * Neither issues a refresh token, and neither token outlives `EXCHANGED_TOKEN_TTL_SECONDS`;
 * B's never outlives the assertion it came from either.
 *
 * ## What decides, and what does not
 *
 * The grant decides, and it is re-read on BOTH exchanges. A's token carries `may_act`, and B's
 * carries `act`, as RFC 8693 describes them, but nothing here reads either to allow anything:
 * they are for the resource server and the audit trail. So revoking a grant refuses the next
 * exchange, including a B presenting an assertion minted while the grant stood. The app a
 * client IS comes from the platform's `place_app` binding (`places.ts`), never from the token
 * or the request, and B re-reads it for both apps: an assertion minted to a client that has
 * since been re-registered to another scope, or bound to a host that has since moved, is dead.
 *
 * No chaining in this version: a subject token that is itself the product of an exchange (it
 * carries `act` or `substrat_delegation`) is refused at A, and B takes only an assertion.
 *
 * ## Order, and what a refusal says
 *
 * The client authenticates before any registry is read, so an unauthenticated caller cannot
 * use the difference between refusals to learn which client ids are places, which apps have
 * grants, or which resources exist (the same reasoning as `places-http.ts`). A refusal is an
 * RFC 6749 §5.2 error whose description names nothing the caller did not send.
 *
 * Pure apart from its dependencies — the SQL, the issuer's own signing and verification, the
 * client authentication and the clock — so every refusal is a node test, and the Durable
 * Object binds the real ones.
 */

/** How long an exchanged token lives, in seconds. Short, because the grant is re-read only on the next exchange. */
export const EXCHANGED_TOKEN_TTL_SECONDS = 300;

/** The subject token types A accepts: a JWT this issuer signed for the host. */
const HOST_SUBJECT_TYPES: ReadonlySet<string> = new Set([TOKEN_TYPE.idToken, TOKEN_TYPE.jwt, TOKEN_TYPE.accessToken]);

export interface TokenExchangeDeps {
  sql: SqlExec;
  /** This issuer's `iss`, the one its own tokens carry. */
  issuer: string;
  /** Seconds since the epoch, read once per request from the runtime's clock. */
  nowSeconds: number;
  /** The token endpoint's own client authentication (`authenticateClient` in the DO). */
  authenticate(clientId: string, clientSecret: string): Promise<boolean>;
  /**
   * The payload of a JWS signed by one of this issuer's own keys, or null. Signature ONLY:
   * `iss`, `exp` and `nbf` are judged here, against `nowSeconds`, so one clock decides.
   */
  verify(token: string): Promise<Record<string, unknown> | null>;
  /** Sign a payload with this issuer's current key, exactly as given. */
  sign(payload: Record<string, unknown>): Promise<string>;
  /** Where a line about a successful exchange goes. Never part of the response. */
  log?: (line: string) => void;
}

/** What the HTTP layer sends back. */
export interface TokenExchangeAnswer {
  status: 200 | 400 | 401;
  body: Record<string, unknown>;
  /** Set on a 401 to a client that tried HTTP Basic (RFC 6749 §5.2). */
  wwwAuthenticate?: string;
}

type Refusal =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'invalid_target'
  | 'invalid_scope';

function refuse(error: Refusal, description: string, basic = false): TokenExchangeAnswer {
  if (error === 'invalid_client') {
    return {
      status: 401,
      body: { error, error_description: description },
      ...(basic ? { wwwAuthenticate: 'Basic realm="token"' } : {}),
    };
  }
  return { status: 400, body: { error, error_description: description } };
}

interface Credentials {
  clientId: string;
  clientSecret: string;
  method: 'client_secret_basic' | 'client_secret_post';
}

/**
 * The client's credentials, from exactly one of RFC 6749 §2.3.1's two presentations. Using
 * both is refused, as the RFC asks. Basic's halves are form-urlencoded before base64, so `+`
 * is a space and `%xx` an octet.
 */
function credentialsOf(form: URLSearchParams, authorization: string | null): Credentials | TokenExchangeAnswer {
  const basic = authorization?.match(/^Basic\s+(\S+)\s*$/i)?.[1];
  const postedId = form.get('client_id');
  const postedSecret = form.get('client_secret');
  if (basic !== undefined) {
    if (postedSecret !== null) return refuse('invalid_request', 'use one client authentication method, not two');
    let decoded: string;
    try {
      decoded = atob(basic);
    } catch {
      return refuse('invalid_client', 'malformed Basic credentials', true);
    }
    const colon = decoded.indexOf(':');
    if (colon < 0) return refuse('invalid_client', 'malformed Basic credentials', true);
    const unform = (s: string) => decodeURIComponent(s.replace(/\+/g, ' '));
    let clientId: string;
    let clientSecret: string;
    try {
      clientId = unform(decoded.slice(0, colon));
      clientSecret = unform(decoded.slice(colon + 1));
    } catch {
      return refuse('invalid_client', 'malformed Basic credentials', true);
    }
    if (postedId !== null && postedId !== clientId) return refuse('invalid_request', 'client_id does not match the credentials');
    return { clientId, clientSecret, method: 'client_secret_basic' };
  }
  if (postedId && postedSecret) return { clientId: postedId, clientSecret: postedSecret, method: 'client_secret_post' };
  return refuse('invalid_client', 'client authentication is required');
}

/** The one audience a token names, or null when it names none or several. */
function soleAudience(aud: unknown): string | null {
  if (typeof aud === 'string') return aud;
  if (Array.isArray(aud) && aud.length === 1 && typeof aud[0] === 'string') return aud[0];
  return null;
}

function audiencesOf(aud: unknown): string[] {
  if (typeof aud === 'string') return [aud];
  if (Array.isArray(aud)) return aud.filter((a): a is string => typeof a === 'string');
  return [];
}

/** A space-separated `scope`, as a list; absent or blank is null (nothing was asked for). */
function scopeList(scope: unknown): string[] | null {
  if (typeof scope !== 'string') return null;
  const tokens = scope.split(' ').filter((s) => s.length > 0);
  return tokens.length ? [...new Set(tokens)] : null;
}

/** The platform-registered MCP resources of one app (`resources.ts`). */
function resourcesOwnedBy(sql: SqlExec, appScopeId: string): string[] {
  const rows = sql.exec('SELECT identifier, metadata FROM oauth_resource').toArray() as {
    identifier: string;
    metadata: unknown;
  }[];
  return rows.filter((r) => platformOwnerOf(r.metadata) === appScopeId).map((r) => r.identifier);
}

/**
 * A subject token this issuer signed and that is live now: the signature, `iss`, `exp`, `nbf`
 * and a `sub`. Anything else about it is the caller's to judge.
 */
async function verifiedSubject(deps: TokenExchangeDeps, token: string): Promise<Record<string, unknown> | null> {
  const payload = await deps.verify(token);
  if (!payload) return null;
  if (payload['iss'] !== deps.issuer) return null;
  const exp = payload['exp'];
  if (typeof exp !== 'number' || exp <= deps.nowSeconds) return null;
  const nbf = payload['nbf'];
  if (nbf !== undefined && (typeof nbf !== 'number' || nbf > deps.nowSeconds)) return null;
  const sub = payload['sub'];
  if (typeof sub !== 'string' || sub.length === 0) return null;
  return payload;
}

/** The substrat_delegation claim of an assertion, when it is well-formed. */
interface DelegationClaim {
  stage: string;
  host: string;
  actor: string;
}

function delegationClaimOf(payload: Record<string, unknown>): DelegationClaim | null {
  const d = payload['substrat_delegation'];
  if (!d || typeof d !== 'object') return null;
  const { stage, host, actor } = d as Record<string, unknown>;
  if (typeof stage !== 'string' || typeof host !== 'string' || typeof actor !== 'string') return null;
  return { stage, host, actor };
}

/**
 * Answer one token-exchange request. `form` is the POSTed body, `authorization` the request's
 * `Authorization` header. Writes nothing: an exchange reads the registries and signs.
 */
export async function exchangeToken(
  deps: TokenExchangeDeps,
  form: URLSearchParams,
  authorization: string | null,
): Promise<TokenExchangeAnswer> {
  if (form.get('grant_type') !== TOKEN_EXCHANGE_GRANT_TYPE) {
    return refuse('invalid_request', 'grant_type must be token exchange');
  }
  const credentials = credentialsOf(form, authorization);
  if ('status' in credentials) return credentials;
  const basic = credentials.method === 'client_secret_basic';

  // Authentication FIRST, before any registry is read (see the header).
  if (!(await deps.authenticate(credentials.clientId, credentials.clientSecret))) {
    return refuse('invalid_client', 'client authentication failed', basic);
  }
  // `authenticate` presents the secret the way the client registered to present it; the
  // plugin's own `/oauth2/token` refuses a client that presents it the other way, and so does
  // this. Read only now, once the client has proved it holds the credentials.
  const registeredMethod = authMethodOf(deps.sql, credentials.clientId);
  if (registeredMethod !== credentials.method) {
    return refuse('invalid_client', `this client authenticates with ${registeredMethod ?? 'another method'}`, basic);
  }
  const client = registrationOfClient(deps.sql, credentials.clientId);
  if (!client) return refuse('unauthorized_client', 'this client is not registered for token exchange');

  const subjectToken = form.get('subject_token');
  const subjectType = form.get('subject_token_type');
  if (!subjectToken || !subjectType) return refuse('invalid_request', 'subject_token and subject_token_type are required');
  // Delegation is the only acting-for this issuer does; an actor token would say something
  // nothing here reads.
  if (form.has('actor_token') || form.has('actor_token_type')) return refuse('invalid_request', 'actor_token is not supported');

  const subject = await verifiedSubject(deps, subjectToken);
  if (!subject) return refuse('invalid_grant', 'the subject token is not a live token of this issuer');

  // Which exchange this is: a subject with no delegation claim is a login (A), one with a
  // delegation claim is the product of an earlier exchange (B, and only if it is an assertion).
  if (subject['substrat_delegation'] === undefined) {
    return assertionFor(deps, form, credentials.clientId, client, subject, subjectType);
  }
  const delegation = delegationClaimOf(subject);
  if (!delegation) return refuse('invalid_grant', 'the subject token is not an assertion of this issuer');
  return accessFor(deps, form, credentials.clientId, client, subject, subjectType, delegation);
}

/** Exchange A: the host, for an assertion addressed to the actor. */
async function assertionFor(
  deps: TokenExchangeDeps,
  form: URLSearchParams,
  hostClientId: string,
  host: { appScopeId: string; tenantId: string },
  subject: Record<string, unknown>,
  subjectType: string,
): Promise<TokenExchangeAnswer> {
  if (!HOST_SUBJECT_TYPES.has(subjectType)) return refuse('invalid_request', 'unsupported subject_token_type');
  const requestedType = form.get('requested_token_type');
  if (requestedType !== null && requestedType !== TOKEN_TYPE.jwt) {
    return refuse('invalid_request', `this exchange issues ${TOKEN_TYPE.jwt}`);
  }
  if (form.has('resource')) return refuse('invalid_request', 'this exchange takes an audience, not a resource');
  const audiences = form.getAll('audience');
  if (audiences.length !== 1 || !audiences[0]) return refuse('invalid_request', 'exactly one audience is required');
  const actorClientId = audiences[0];

  // No chaining: a token that is itself the product of an exchange is not a login.
  if (subject['act'] !== undefined) return refuse('invalid_grant', 'the subject token is already delegated');

  // Bound to the host: issued to it (an authorized party that is the host, and nobody else),
  // or with no authorized party, an id_token addressed to the host alone or an access token
  // for one of the host's own MCP resources.
  const parties = [subject['azp'], subject['client_id']].filter((p) => p !== undefined);
  const boundToHost =
    parties.length > 0
      ? parties.every((p) => p === hostClientId)
      : soleAudience(subject['aud']) === hostClientId ||
        audiencesOf(subject['aud']).some((a) => resourcesOwnedBy(deps.sql, host.appScopeId).includes(a));
  if (!boundToHost) return refuse('invalid_grant', 'the subject token was not issued to this client');

  const actor = registrationOfClient(deps.sql, actorClientId);
  if (!actor || actor.tenantId !== host.tenantId) {
    return refuse('invalid_target', `${actorClientId} is not an app this client may delegate to`);
  }
  const grant = grantFor(deps.sql, host.appScopeId, actor.appScopeId);
  if (!grant) return refuse('invalid_target', `this client does not delegate to ${actorClientId}`);

  const requested = scopeList(form.get('scope'));
  const scope = requested ? requested.filter((s) => grant.permissions.includes(s)) : grant.permissions;
  if (scope.length === 0) return refuse('invalid_scope', 'none of the requested scope is delegated');

  const exp = deps.nowSeconds + EXCHANGED_TOKEN_TTL_SECONDS;
  const token = await deps.sign({
    iss: deps.issuer,
    sub: subject['sub'],
    aud: actorClientId,
    azp: hostClientId,
    client_id: hostClientId,
    scope: scope.join(' '),
    // Informational (RFC 8693 §4.4): the grant is what B checks, never this.
    may_act: { iss: deps.issuer, sub: actorClientId },
    substrat_delegation: { stage: 'assertion', host: host.appScopeId, actor: actor.appScopeId },
    iat: deps.nowSeconds,
    exp,
    jti: crypto.randomUUID(),
  });
  deps.log?.(
    `auth-server: token exchange ${JSON.stringify({ stage: 'assertion', host: host.appScopeId, actor: actor.appScopeId, scope: scope.join(' ') })}`,
  );
  return {
    status: 200,
    body: {
      access_token: token,
      issued_token_type: TOKEN_TYPE.jwt,
      // RFC 8693 §2.2.1: an assertion is not an access token, and is not usable as one.
      token_type: 'N_A',
      expires_in: exp - deps.nowSeconds,
      scope: scope.join(' '),
    },
  };
}

/** Exchange B: the actor, for an access token to the host's MCP endpoint. */
async function accessFor(
  deps: TokenExchangeDeps,
  form: URLSearchParams,
  actorClientId: string,
  actorNow: { appScopeId: string; tenantId: string },
  assertion: Record<string, unknown>,
  subjectType: string,
  delegation: DelegationClaim,
): Promise<TokenExchangeAnswer> {
  // Only an assertion is exchanged here: an access token from an earlier B is not a way in
  // again (no chaining), whatever the rest of the request says.
  if (delegation.stage !== 'assertion') return refuse('invalid_grant', 'the subject token is not an assertion');
  // The assertion, and whether it is still true, before the shape of the request (so the host
  // presenting its own assertion back as an A is refused as a grant, not as a form). Every fact
  // is re-read from the platform's bindings rather than trusted from the token: which app this
  // client is NOW, and which app the host's client is NOW.
  if (soleAudience(assertion['aud']) !== actorClientId) {
    return refuse('invalid_grant', 'the assertion is not addressed to this client');
  }
  if (actorNow.appScopeId !== delegation.actor) return refuse('invalid_grant', 'the assertion is for another app');
  const hostClientId = assertion['azp'];
  const hostNow = typeof hostClientId === 'string' ? registrationOfClient(deps.sql, hostClientId) : undefined;
  if (!hostNow || hostNow.appScopeId !== delegation.host) {
    return refuse('invalid_grant', 'the app that issued the assertion is no longer bound to it');
  }
  // Revocation: the grant as it stands now, not as it stood when the assertion was minted.
  const grant = grantFor(deps.sql, delegation.host, delegation.actor);
  if (!grant) return refuse('invalid_grant', 'the delegation behind this assertion has been revoked');

  if (subjectType !== TOKEN_TYPE.jwt) return refuse('invalid_request', `an assertion is presented as ${TOKEN_TYPE.jwt}`);
  const requestedType = form.get('requested_token_type');
  if (requestedType !== null && requestedType !== TOKEN_TYPE.accessToken) {
    return refuse('invalid_request', `this exchange issues ${TOKEN_TYPE.accessToken}`);
  }
  if (form.has('audience')) return refuse('invalid_request', 'this exchange takes a resource, not an audience');
  const resources = form.getAll('resource');
  if (resources.length === 0 || !resources[0]) return refuse('invalid_request', 'a resource is required');
  if (resources.length > 1) return refuse('invalid_target', 'exactly one resource may be requested');
  const resource = resources[0];

  if (!resourcesOwnedBy(deps.sql, delegation.host).includes(resource)) {
    return refuse('invalid_target', `${resource} is not a resource of the delegating app`);
  }

  const asserted = scopeList(assertion['scope']) ?? [];
  const requested = scopeList(form.get('scope'));
  const scope = asserted.filter((s) => grant.permissions.includes(s) && (!requested || requested.includes(s)));
  if (scope.length === 0) return refuse('invalid_scope', 'none of the requested scope is delegated');

  const assertionExp = assertion['exp'] as number;
  const exp = Math.min(deps.nowSeconds + EXCHANGED_TOKEN_TTL_SECONDS, assertionExp);
  const token = await deps.sign({
    iss: deps.issuer,
    sub: assertion['sub'],
    aud: resource,
    azp: actorClientId,
    client_id: actorClientId,
    scope: scope.join(' '),
    act: { iss: deps.issuer, sub: actorClientId },
    substrat_delegation: { stage: 'access', host: delegation.host, actor: delegation.actor },
    iat: deps.nowSeconds,
    exp,
    jti: crypto.randomUUID(),
  });
  deps.log?.(
    `auth-server: token exchange ${JSON.stringify({ stage: 'access', host: delegation.host, actor: delegation.actor, scope: scope.join(' ') })}`,
  );
  return {
    status: 200,
    body: {
      access_token: token,
      issued_token_type: TOKEN_TYPE.accessToken,
      token_type: 'Bearer',
      expires_in: exp - deps.nowSeconds,
      scope: scope.join(' '),
    },
  };
}
