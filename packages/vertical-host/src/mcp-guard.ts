import { TrieRouter } from 'hono/router/trie-router';
import { splitRoutingPath } from 'hono/utils/url';

/**
 * What the MCP mount and the operation routes share to keep a delegated token (#1824) at the
 * one endpoint that holds it to its scope. Internal: not re-exported from the package.
 */

/**
 * The claims of a presented JWS bearer, read WITHOUT checking its signature, or `null` when
 * there is no bearer or it is not a JWS. Only ever used to refuse: the resolver verifies the
 * same token, and a request has to pass both.
 */
export function bearerClaims(authorization: string | undefined): Record<string, unknown> | null {
  if (!authorization?.toLowerCase().startsWith('bearer ')) return null;
  const segments = authorization.slice(7).trim().split('.');
  if (segments.length !== 3) return null;
  let claims: unknown;
  try {
    const b64 = segments[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')), (ch) =>
      ch.charCodeAt(0),
    );
    claims = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null; // not a JWS payload, so not a token whose claims can be read here
  }
  return claims !== null && typeof claims === 'object' ? (claims as Record<string, unknown>) : null;
}

/** Whether the request's bearer is a DELEGATED token: one carrying RFC 8693 `act`. */
export function carriesAct(authorization: string | undefined): boolean {
  return bearerClaims(authorization)?.['act'] !== undefined;
}

/** A route as Hono registered it: what `app.routes` holds. */
export interface RegisteredRoute {
  readonly method: string;
  readonly path: string;
}

/**
 * The first of `routes` that would answer a request for the concrete `path`, by any method but
 * `OPTIONS`. It is judged by Hono's `TrieRouter`, after Hono's own splitting of the pattern, so
 * parameters, regex parameters and optional parameters are read the way Hono reads them.
 *
 * Not judged, and never returned:
 *  - a route registered for every method (`app.use`, `app.all`, `app.mount`, which Hono records
 *    alike as `ALL`);
 *  - an `OPTIONS` route (a CORS preflight);
 *  - a pattern with a `*` anywhere outside a parameter's regex: a `*` segment (a catch-all) and
 *    a `*` inside one (`/api/*cp`, `/ap*` + `/mcp`) alike. Hono's routers do not agree on the
 *    second kind (the default router dispatches both of those to `/api/mcp`, and `TrieRouter`
 *    neither), so judging it would refuse boots that are fine on one router and miss
 *    shadowing on another.
 */
export function routeAnsweringAt(routes: readonly RegisteredRoute[], path: string): RegisteredRoute | undefined {
  for (const route of routes) {
    if (route.method === 'ALL' || route.method === 'OPTIONS') continue;
    if (splitRoutingPath(route.path).some((segment) => !segment.startsWith(':') && segment.includes('*'))) continue;
    const probe = new TrieRouter<true>();
    try {
      probe.add(route.method, route.path, true);
    } catch {
      continue; // a pattern Hono itself would not register
    }
    if (probe.match(route.method, path)[0].length > 0) return route;
  }
  return undefined;
}
