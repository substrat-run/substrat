import { TrieRouter } from 'hono/router/trie-router';
import { mergePath } from 'hono/utils/url';

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
 * `OPTIONS`. It is judged by Hono's own `TrieRouter`, so parameters, regex parameters, optional
 * parameters and wildcards are read the way Hono reads them.
 *
 * Not judged, and never returned:
 *  - a route registered for every method (`app.use`, `app.all`, `app.mount`, which Hono records
 *    alike as `ALL`);
 *  - an `OPTIONS` route (a CORS preflight).
 *
 * A `*` is judged as `TrieRouter` reads it, wherever it is:
 *  - A segment that is exactly `*` matches one segment, or, at the end, any rest including
 *    none. Every Hono router that accepts such a pattern dispatches it alike. So `*`,
 *    `/api/*`, `/api/mcp/*` and `/*` + `/mcp` are returned for `/api/mcp`, and `/other/*` and
 *    `/api/*` + `/mcp` are not.
 *  - A `*` inside a segment (`/api/mc*`, `/ap*`) or inside a parameter's regex is judged too.
 *    The default router also dispatches some mid-segment forms that `TrieRouter` does not
 *    match, such as `/api/*cp` and `/ap*` + `/mcp`. Those are not returned.
 */
export function routeAnsweringAt(routes: readonly RegisteredRoute[], path: string): RegisteredRoute | undefined {
  for (const route of routes) {
    if (route.method === 'ALL' || route.method === 'OPTIONS') continue;
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

/**
 * The path a route registered on `app` at `path` is served at. An app made by Hono's
 * `basePath()` prefixes every path it registers, and keeps the prefix in `_basePath`, a field
 * Hono's types mark private. It is read here so the MCP mount can be judged before it
 * registers anything, and composed with `mergePath` exactly as Hono's own route registration
 * does. The suite pins the two together, so a Hono that moved the prefix reddens a test
 * instead of judging the wrong path.
 */
export function servedPathOf(app: object, path: string): string {
  const prefix = (app as { _basePath?: unknown })._basePath;
  return mergePath(typeof prefix === 'string' ? prefix : '/', path);
}

/**
 * Refuse operations two of which would render as one MCP tool name. `toolName` is
 * `mcpToolName`, passed in so this module stays free of `mcp.ts`. The operations that get a
 * tool are the ones with a route that did not opt out (`mcp: false`), walked in name order, so
 * every caller names the same pair. `caller` is what the error names: `mcpToolsOf` itself, or
 * the mount that judges it before registering anything.
 */
export function assertDistinctToolNames(
  operations: Readonly<Record<string, object>>,
  toolName: (operation: string) => string,
  caller: 'mcpToolsOf' | 'mountMcp' | 'mountOperations',
): void {
  const byName = new Map<string, string>();
  for (const operation of Object.keys(operations).sort()) {
    const op = operations[operation] as { http?: unknown; mcp?: unknown } | undefined;
    if (!op?.http || op.mcp === false) continue;
    const name = toolName(operation);
    const clash = byName.get(name);
    if (clash) {
      throw new Error(
        `${caller}: '${operation}' and '${clash}' both render as the tool name '${name}' — ` +
          'operation names must stay distinct once non-alphanumerics collapse to `_`',
      );
    }
    byName.set(name, operation);
  }
}

/**
 * Refuse an MCP endpoint at `path` when a route already registered on `app` would answer there
 * in its place (`routeAnsweringAt`, at the path the endpoint is served at). Called before
 * anything is registered, so a refused mount leaves the app as it found it. `caller` is the
 * mount the error names.
 */
export function assertMcpPathFree(
  app: { readonly routes: readonly RegisteredRoute[] },
  path: string,
  caller: 'mountMcp' | 'mountOperations',
): void {
  const answersAt = servedPathOf(app, path);
  const shadow = routeAnsweringAt(app.routes, answersAt);
  if (shadow) {
    throw new Error(
      `${caller}: ${shadow.method} ${shadow.path} is registered before the MCP endpoint and would answer at ${answersAt} ` +
        'in its place — move that route off the path',
    );
  }
}
