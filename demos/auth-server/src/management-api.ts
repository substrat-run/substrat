import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import type { SqlExec } from './introspect.js';
import { isPlaceholderAddress } from './placeholder-address.js';
import { readActivity, readClientActivity } from './user-activity.js';

/**
 * A STRICT SUBSET of the Auth0 Management API v2 (#3107), so an operator's own app can ask this
 * issuer about its people with any client written against Auth0 (`node-auth0`, Terraform, …).
 *
 * The rule is strict where implemented, explicit where not:
 *
 *   - An endpoint served here uses Auth0's path, query parameters, field names and error body
 *     (`{ statusCode, error, message, errorCode }`) exactly.
 *   - A query parameter Auth0 would reject, or one this issuer does not support, is a 400 in
 *     Auth0's words. Nothing is silently ignored.
 *   - An Auth0 endpoint not served here is a 501 naming it, never a 404 that reads as "no such
 *     user" and never an empty answer.
 *   - Every place this differs from Auth0 is a row in `MANAGEMENT-API.md`, beside this
 *     package's `package.json`, and `test/management-api.test.ts` pins the ones that guard data.
 *
 * WHO MAY CALL. A machine client's `client_credentials` token for this issuer's Management API
 * audience (`{issuer}/api/v2/`, Auth0's own spelling), holding an Auth0 scope. The scope must
 * ALSO be in the operator's `MACHINE_SCOPES` ceiling, which is what makes this opt-in: an issuer
 * whose ceiling has no `read:users` mints no token that can read anyone. The check is repeated
 * on every request, against the client's row as it is now, so disabling a client or taking a
 * scope away ends its access at once rather than when the token expires.
 *
 * WHAT IS NEVER SERVED. A BankID identity's `user_id`, which is the person's personal number,
 * and anything the sign-in log holds beyond a time: no IP, no user agent, no method.
 */

/** The scopes this subset understands, in Auth0's names. A ceiling entry is what enables each. */
export const MANAGEMENT_API_SCOPES = ['read:users'] as const;
type ManagementScope = (typeof MANAGEMENT_API_SCOPES)[number];

/** Auth0's Management API audience for an issuer: `https://{domain}/api/v2/`, trailing slash and all. */
export function managementAudience(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/api/v2/`;
}

/** What marks the resource row as this module's, for a reader of `oauth_resource`. */
const RESOURCE_MARKER = JSON.stringify({ substrat: { managementApi: true } });

/**
 * Register the Management API audience as an `oauth_resource`, which the plugin needs before it
 * will mint a token for it (`invalid_target` otherwise). Only while the operator's ceiling holds
 * a Management API scope: without one the row would let nobody do anything, and its absence
 * keeps an issuer that never opted in exactly as it was. Idempotent; the row carries no
 * platform marker (`resources.ts`), so a platform delivery never claims or removes it.
 */
export function ensureManagementResource(sql: SqlExec, issuer: string, machineScopes: readonly string[]): void {
  if (!MANAGEMENT_API_SCOPES.some((s) => machineScopes.includes(s))) return;
  const identifier = managementAudience(issuer);
  sql.exec(
    `INSERT INTO oauth_resource (id, identifier, name, metadata, created_at, updated_at)
     SELECT ?, ?, 'Auth0 Management API', ?, cast(unixepoch('subsecond') * 1000 as integer), cast(unixepoch('subsecond') * 1000 as integer)
     WHERE NOT EXISTS (SELECT 1 FROM oauth_resource WHERE identifier = ?)`,
    crypto.randomUUID(),
    identifier,
    RESOURCE_MARKER,
    identifier,
  );
}

/* ---- the token endpoint, Auth0's way (`POST /oauth/token`) ---- */

/** The path Auth0 serves its token endpoint at, and that Auth0's SDKs post to. */
export const AUTH0_TOKEN_PATH = '/oauth/token';

/**
 * Turn an Auth0-style token request into the form this issuer's own endpoint reads.
 *
 * Three differences, all Auth0's:
 *   - the body may be JSON as well as a form;
 *   - the API is named by `audience` rather than RFC 8707's `resource` (naming it both ways at
 *     once is refused, since there is no telling which was meant);
 *   - a client's secret may arrive in the body whatever the client was registered for. Auth0's
 *     SDKs post it there, while the console registers every machine client for HTTP Basic, and
 *     the plugin holds a client to its registered method. So for a Basic client with no
 *     Authorization header, the body's credentials become that header.
 *
 * Everything else passes through untouched for the plugin to judge, so a refusal from here on is
 * the plugin's own OAuth error body, which is also the shape Auth0 answers its token endpoint
 * with. `authorization` is the header to forward, if any.
 */
export async function auth0TokenForm(
  request: Request,
  authMethodOf: (clientId: string) => string | undefined,
): Promise<{ form: URLSearchParams; authorization?: string } | { error: OAuthError }> {
  const type = request.headers.get('content-type')?.toLowerCase() ?? '';
  let form: URLSearchParams;
  if (type.startsWith('application/x-www-form-urlencoded')) {
    form = new URLSearchParams(await request.text());
  } else if (type.startsWith('application/json')) {
    const body: unknown = await request.json().catch(() => undefined);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { error: oauthError('invalid_request', 'the request body is not a JSON object') };
    }
    form = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (typeof value !== 'string') return { error: oauthError('invalid_request', `${key} must be a string`) };
      form.set(key, value);
    }
  } else {
    return { error: oauthError('invalid_request', 'the body must be application/x-www-form-urlencoded or application/json') };
  }
  const audience = form.get('audience');
  if (audience !== null) {
    if (form.has('resource')) return { error: oauthError('invalid_request', 'name the API by audience or by resource, not both') };
    form.delete('audience');
    form.set('resource', audience);
  }
  const header = request.headers.get('authorization') ?? undefined;
  const clientId = form.get('client_id');
  const secret = form.get('client_secret');
  if (!header && clientId && secret !== null && authMethodOf(clientId) === 'client_secret_basic') {
    form.delete('client_id');
    form.delete('client_secret');
    return { form, authorization: `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`)}` };
  }
  return { form, ...(header ? { authorization: header } : {}) };
}

/** A client's registered `token_endpoint_auth_method`, for `auth0TokenForm`. */
export function tokenAuthMethodOf(sql: SqlExec, clientId: string): string | undefined {
  const row = sql.exec('SELECT token_endpoint_auth_method FROM oauth_client WHERE client_id = ?', clientId).toArray()[0] as
    | { token_endpoint_auth_method: string | null }
    | undefined;
  return row?.token_endpoint_auth_method ?? undefined;
}

/**
 * A refused token request's body, which the caller answers with a 400 and `no-store`. A body
 * rather than a `Response` because the two runtimes build theirs from different type universes.
 */
export interface OAuthError {
  error: 'invalid_request';
  error_description: string;
}

function oauthError(error: OAuthError['error'], description: string): OAuthError {
  return { error, error_description: description };
}

/* ---- the Management API itself ---- */

/**
 * A verifier for Management API bearer tokens: signed by this issuer's own keys (the JWKS a
 * relying party would read), issued by it, for its Management API audience, typed as an access
 * token (RFC 9068 `at+jwt`), and unexpired. Anything else is null.
 */
export function managementTokenVerifier(
  jwks: () => Promise<JSONWebKeySet>,
  issuer: string,
): (token: string) => Promise<JWTPayload | null> {
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, createLocalJWKSet(await jwks()), {
        issuer,
        audience: managementAudience(issuer),
        typ: 'at+jwt',
      });
      return payload;
    } catch {
      return null;
    }
  };
}

export interface ManagementApiDeps {
  sql: SqlExec;
  verify: (token: string) => Promise<JWTPayload | null>;
  /** The operator's `MACHINE_SCOPES` ceiling, read per request like everywhere else. */
  machineScopes: () => readonly string[];
}

type Env = { Variables: { scopes: readonly string[] } };

/** Auth0's error body. `errorCode` is present wherever Auth0 sends one. */
function auth0Error(c: Context, status: ContentfulStatusCode, message: string, errorCode?: string): Response {
  return c.json({ statusCode: status, error: REASON[status] ?? 'Error', message, ...(errorCode ? { errorCode } : {}) }, status);
}

const REASON: Partial<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  500: 'Internal Server Error',
  501: 'Not Implemented',
};

/** A client's row as the bearer check reads it. */
interface CallerRow {
  disabled: number | null;
  grant_types: string | null;
  client_credentials_scopes: string | null;
}

function jsonList(value: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The scopes a bearer may use right now: what its token says, narrowed to what its client still
 * holds and the ceiling still allows. Refused, with Auth0's 401 message, when the token is not
 * a live machine client's.
 */
async function callerScopes(deps: ManagementApiDeps, token: string): Promise<{ scopes: readonly string[] } | { refused: string }> {
  const claims = await deps.verify(token);
  if (!claims) return { refused: 'Invalid token' };
  const clientId = typeof claims.azp === 'string' ? claims.azp : null;
  // A person's token names the person; a machine token names its own client. Auth0's user-scoped
  // Management API tokens (`read:current_user`) are not served here.
  if (!clientId || claims.sub !== clientId) return { refused: 'Invalid token: only a client_credentials token is accepted' };
  const row = deps.sql
    .exec('SELECT disabled, grant_types, client_credentials_scopes FROM oauth_client WHERE client_id = ?', clientId)
    .toArray()[0] as unknown as CallerRow | undefined;
  if (!row || row.disabled) return { refused: 'Invalid token: the client is disabled or no longer exists' };
  // The console's own definition of a machine client (`isMachineGrant` in `admin-api.ts`).
  const grants = jsonList(row.grant_types);
  if (!grants.includes('client_credentials') || grants.includes('authorization_code')) {
    return { refused: 'Invalid token: the client is not a machine client' };
  }
  const held = jsonList(row.client_credentials_scopes);
  const ceiling = deps.machineScopes();
  const asked = typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : [];
  return { scopes: asked.filter((s) => held.includes(s) && ceiling.includes(s)) };
}

/** Refuse unless the caller holds one of `scopes`, in Auth0's words. */
function requireScope(c: Context<Env>, ...scopes: ManagementScope[]): Response | undefined {
  if (scopes.some((s) => c.get('scopes').includes(s))) return undefined;
  return auth0Error(c, 403, `Insufficient scope, expected any of: ${scopes.join(',')}`, 'insufficient_scope');
}

/**
 * Hold a request's query to the parameters this route takes. Auth0 refuses an unknown one with
 * this message, and so does this subset. Every route here takes all of Auth0's parameters for it,
 * so an Auth0 parameter is never refused as unknown.
 */
function refuseQuery(c: Context<Env>, accepted: readonly string[]): Response | undefined {
  for (const key of new URL(c.req.url).searchParams.keys()) {
    if (!accepted.includes(key)) {
      return auth0Error(c, 400, `Query validation error: 'Additional properties not allowed: ${key}' on property query.`, 'invalid_query_string');
    }
  }
  return undefined;
}

/** `fields` + `include_fields`, Auth0's projection. Undefined is "every field". */
type Projection = { fields: Set<string>; include: boolean } | undefined;

function projectionOf(c: Context<Env>): Projection | Response {
  const fields = c.req.query('fields');
  const include = c.req.query('include_fields');
  if (include !== undefined && include !== 'true' && include !== 'false') {
    return auth0Error(c, 400, `Query validation error: 'Expected type boolean but found type string' on property include_fields.`, 'invalid_query_string');
  }
  if (!fields) return undefined;
  return { fields: new Set(fields.split(',').map((f) => f.trim()).filter(Boolean)), include: include !== 'false' };
}

function project(user: Auth0User, projection: Projection): Partial<Auth0User> {
  if (!projection) return user;
  return Object.fromEntries(
    Object.entries(user).filter(([key]) => projection.fields.has(key) === projection.include),
  ) as Partial<Auth0User>;
}

/** An Auth0 identity, as this issuer can tell it. */
interface Auth0Identity {
  connection: string;
  provider: string;
  user_id?: string;
  isSocial: boolean;
}

/** The Auth0 user object, the fields this issuer has. Absent means absent, as in Auth0. */
interface Auth0User {
  user_id: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  phone_number?: string;
  created_at: string;
  updated_at: string;
  identities: Auth0Identity[];
  last_login?: string;
  logins_count?: number;
  blocked?: boolean;
}

interface UserRow {
  id: string;
  email: string;
  email_verified: number;
  name: string | null;
  image: string | null;
  phone_number: string | null;
  created_at: number;
  updated_at: number;
  banned: number | null;
}

const USER_COLUMNS = 'id, email, email_verified, name, image, phone_number, created_at, updated_at, banned';

/**
 * Providers whose account id is personal data, so the identity's `user_id` is withheld. BankID's
 * is the personal number (`bankid-plugin.ts`).
 */
const WITHHELD_IDENTITY_IDS = new Set(['bankid']);

/** Providers that are not a social login. Every other provider here is an upstream OAuth one. */
const NOT_SOCIAL = new Set(['credential', 'bankid']);

/**
 * One account row as an Auth0 identity. A password is Auth0's default database connection, which
 * is what a client written against Auth0 looks for. Every other provider keeps this issuer's own
 * id as both `provider` and `connection` (`google`, not Auth0's `google-oauth2`).
 */
function identityOf(row: { provider_id: string; account_id: string }): Auth0Identity {
  const password = row.provider_id === 'credential';
  return {
    connection: password ? 'Username-Password-Authentication' : row.provider_id,
    provider: password ? 'auth0' : row.provider_id,
    ...(WITHHELD_IDENTITY_IDS.has(row.provider_id) ? {} : { user_id: row.account_id }),
    isSocial: !NOT_SOCIAL.has(row.provider_id),
  };
}

const iso = (ms: number): string => new Date(Number(ms)).toISOString();

function toAuth0User(sql: SqlExec, row: UserRow): Auth0User {
  const identities = (
    sql.exec('SELECT provider_id, account_id FROM account WHERE user_id = ? ORDER BY created_at', row.id).toArray() as {
      provider_id: string;
      account_id: string;
    }[]
  ).map(identityOf);
  const activity = readActivity(sql, row.id);
  // A BankID placeholder address is this issuer's stand-in, never the person's: Auth0 has no
  // email at all for such a user, and neither does this answer.
  const placeholder = isPlaceholderAddress(row.email);
  return {
    user_id: row.id,
    ...(placeholder ? {} : { email: row.email, email_verified: Boolean(row.email_verified) }),
    ...(row.name ? { name: row.name } : {}),
    ...(row.image ? { picture: row.image } : {}),
    ...(row.phone_number ? { phone_number: row.phone_number } : {}),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    identities,
    ...(activity.lastLoginAt ? { last_login: iso(activity.lastLoginAt) } : {}),
    ...(activity.loginsCount ? { logins_count: activity.loginsCount } : {}),
    ...(row.banned ? { blocked: true } : {}),
  };
}

function userRow(sql: SqlExec, where: 'id' | 'email', value: string): UserRow | undefined {
  return sql.exec(`SELECT ${USER_COLUMNS} FROM user WHERE ${where} = ?`, value).toArray()[0] as unknown as UserRow | undefined;
}

/** The Hono app for `/api/v2/*`. Mount it at `/api/v2`. */
export function createManagementApi(deps: ManagementApiDeps): Hono<Env> {
  const api = new Hono<Env>();

  api.onError((err, c) => {
    console.error('management api: unexpected error', err);
    return auth0Error(c, 500, 'Internal Server Error');
  });

  // Authentication first, for every path: Auth0 says "Missing authentication" before it says
  // anything about the endpoint, so an anonymous caller learns nothing about what is served.
  api.use('*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match?.[1]) return auth0Error(c, 401, 'Missing authentication');
    const caller = await callerScopes(deps, match[1]);
    if ('refused' in caller) return auth0Error(c, 401, caller.refused);
    c.set('scopes', caller.scopes);
    await next();
  });

  // GET /api/v2/users-by-email — Auth0's exact-match lookup. Emails here are stored lowercased,
  // so, as in Auth0's own database connections, a differently-cased query finds nobody.
  api.get('/users-by-email', (c) => {
    const refused = requireScope(c, 'read:users') ?? refuseQuery(c, ['email', 'fields', 'include_fields']);
    if (refused) return refused;
    const projection = projectionOf(c);
    if (projection instanceof Response) return projection;
    const email = c.req.query('email');
    if (!email) {
      return auth0Error(c, 400, `Query validation error: 'Missing required property: email' on property query.`, 'invalid_query_string');
    }
    if (isPlaceholderAddress(email)) return c.json([]);
    const row = userRow(deps.sql, 'email', email);
    return c.json(row ? [project(toAuth0User(deps.sql, row), projection)] : []);
  });

  // GET /api/v2/users/{id}
  api.get('/users/:id', (c) => {
    const refused = requireScope(c, 'read:users') ?? refuseQuery(c, ['fields', 'include_fields']);
    if (refused) return refused;
    const projection = projectionOf(c);
    if (projection instanceof Response) return projection;
    const row = userRow(deps.sql, 'id', c.req.param('id'));
    if (!row) return auth0Error(c, 404, 'The user does not exist.', 'inexistent_user');
    return c.json(project(toAuth0User(deps.sql, row), projection));
  });

  /**
   * EXTENSION, not Auth0: GET /api/v2/users/{id}/x-client-activity — when each application last
   * got a token for this person (`user-activity.ts`). Auth0 keeps no such record, so there is no
   * Auth0 shape to follow; the `x-` prefix is what keeps it from ever meaning an Auth0 endpoint.
   */
  api.get('/users/:id/x-client-activity', (c) => {
    const refused = requireScope(c, 'read:users') ?? refuseQuery(c, []);
    if (refused) return refused;
    const id = c.req.param('id');
    if (!userRow(deps.sql, 'id', id)) return auth0Error(c, 404, 'The user does not exist.', 'inexistent_user');
    return c.json({
      user_id: id,
      clients: readClientActivity(deps.sql, id).map((a) => ({
        client_id: a.clientId,
        ...(a.name ? { name: a.name } : {}),
        last_token_at: iso(a.lastTokenAt),
      })),
    });
  });

  // Everything else Auth0 serves under /api/v2 is not served here, and says so by name.
  api.all('*', (c) =>
    auth0Error(
      c,
      501,
      `${c.req.method} ${new URL(c.req.url).pathname} is not part of this issuer's Auth0 Management API subset.`,
      'not_implemented',
    ),
  );

  return api;
}

/** The whole surface, mounted where Auth0 serves it. */
export function managementApiApp(deps: ManagementApiDeps): Hono {
  return new Hono().route('/api/v2', createManagementApi(deps));
}
