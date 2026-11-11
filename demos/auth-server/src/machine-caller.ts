import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import type { SqlExec } from './introspect.js';

/**
 * What the issuer's own machine-facing APIs share: the Auth0 Management API subset
 * (`management-api.ts`, #3107) and the SCIM server (`scim.ts`, #2941). Both are called by a
 * machine client holding a `client_credentials` token for the API's audience, and both are opt-in
 * the same way: the API's scope must be in the operator's `MACHINE_SCOPES` ceiling AND held by
 * the client, and both are re-checked on every request, so disabling a client or taking a scope
 * away ends its access at once rather than when the token expires.
 */

/**
 * Register an API's audience as an `oauth_resource`, which the plugin needs before it will mint
 * a token for it (`invalid_target` otherwise). Only while the operator's ceiling holds one of the
 * API's scopes: without one the row would let nobody do anything, and its absence keeps an
 * issuer that never opted in exactly as it was. Idempotent; the row carries no platform marker
 * (`resources.ts`), so a platform delivery never claims or removes it.
 */
export function ensureMachineResource(
  sql: SqlExec,
  resource: { identifier: string; name: string; marker: string; scopes: readonly string[] },
  machineScopes: readonly string[],
): void {
  if (!resource.scopes.some((s) => machineScopes.includes(s))) return;
  sql.exec(
    `INSERT INTO oauth_resource (id, identifier, name, metadata, created_at, updated_at)
     SELECT ?, ?, ?, ?, cast(unixepoch('subsecond') * 1000 as integer), cast(unixepoch('subsecond') * 1000 as integer)
     WHERE NOT EXISTS (SELECT 1 FROM oauth_resource WHERE identifier = ?)`,
    crypto.randomUUID(),
    resource.identifier,
    resource.name,
    resource.marker,
    resource.identifier,
  );
}

/**
 * A verifier for an API's bearer tokens: signed by this issuer's own keys (the JWKS a relying
 * party would read), issued by it, for `audience`, typed as an access token (RFC 9068 `at+jwt`),
 * and unexpired. Anything else is null.
 */
export function machineTokenVerifier(
  jwks: () => Promise<JSONWebKeySet>,
  issuer: string,
  audience: string,
): (token: string) => Promise<JWTPayload | null> {
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, createLocalJWKSet(await jwks()), { issuer, audience, typ: 'at+jwt' });
      return payload;
    } catch {
      return null;
    }
  };
}

export interface MachineCallerDeps {
  sql: SqlExec;
  verify: (token: string) => Promise<JWTPayload | null>;
  /** The operator's `MACHINE_SCOPES` ceiling, read per request like everywhere else. */
  machineScopes: () => readonly string[];
}

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
 * Who a bearer is and the scopes it may use right now: what its token says, narrowed to what its
 * client still holds and the ceiling still allows. Refused, with a reason for a 401, when the
 * token is not a live machine client's.
 */
export async function machineCaller(
  deps: MachineCallerDeps,
  token: string,
): Promise<{ clientId: string; scopes: readonly string[] } | { refused: string }> {
  const claims = await deps.verify(token);
  if (!claims) return { refused: 'Invalid token' };
  const clientId = typeof claims.azp === 'string' ? claims.azp : null;
  // A person's token names the person; a machine token names its own client.
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
  return { clientId, scopes: asked.filter((s) => held.includes(s) && ceiling.includes(s)) };
}
