/**
 * A vertical's MCP endpoint, named the ONE way both of its ends name it (#1619).
 *
 * The endpoint `mountOperations` mounts is an OAuth protected resource, and its identifier
 * is a string two parties have to agree on byte for byte. The vertical publishes it in its
 * RFC 9728 document and holds a presented token to it (`aud`). The platform registers it
 * at the vertical's issuer, which refuses to mint for any `resource` it has no row for
 * (RFC 8707). If each side built the string itself, one would eventually add a trailing
 * slash the other did not, and the only symptom would be `invalid_target` at a login that
 * never renders.
 *
 * So both sides call these. `@substrat-run/vertical-host` uses them for the document and
 * for the `aud` check. The dashboard uses them for the resources it registers, one per
 * hostname the app answers on, because the identifier is the URL a client actually
 * reached.
 */

/** Where the MCP endpoint lives under a vertical's API base path: `${basePath}/mcp`. */
export function mcpEndpointPath(basePath = '/api'): string {
  return `${basePath}/mcp`;
}

/**
 * The fleet's convention, `/api/mcp`, which is `mountOperations`' default. It is the only
 * path the platform can register without asking the vertical, so a vertical that mounts
 * the endpoint elsewhere (`mcp.path`) or pins a different `resource` is not covered by
 * the platform's registration.
 */
export const MCP_ENDPOINT_PATH = mcpEndpointPath();

/**
 * An MCP endpoint's resource identifier: its own absolute URL on the origin a client
 * reached it at. `origin` is `scheme://host[:port]` with no trailing slash, which is what
 * `new URL(…).origin` returns.
 */
export function mcpResourceOf(origin: string, path: string = MCP_ENDPOINT_PATH): string {
  return `${origin}${path}`;
}

/**
 * The delivered-config key through which the platform tells a team auth-server which MCP
 * endpoints it may mint for: `${MCP_RESOURCES_CONFIG_PREFIX}<app scope id>`, whose value is
 * that app's whole set as a JSON array of `mcpResourceOf` identifiers, or `""` for none.
 * The dashboard writes it. `demos/auth-server/src/resources.ts` turns it into rows.
 */
export const MCP_RESOURCES_CONFIG_PREFIX = 'substrat:resources:';
