/**
 * `@substrat-run/control-plane-client` — the typed HTTP client for the control-plane API.
 *
 * Apache-2.0 on purpose (LICENSING.md): the CLI a builder runs against their own code, and
 * the console and the connect seam, all import it, and a client library that
 * copyleft-captured its callers would capture every vertical built on Substrat. The AGPL
 * server it talks to is `@substrat-run/control-plane-api`, which re-exports this surface.
 *
 * Everything reachable from here is `fetch` + `@substrat-run/contracts` — never `hono`,
 * never a Node builtin — so a bundler can follow it into a page. `test/entry.test.ts`
 * holds that line.
 */
export { ControlPlaneTransport, ControlPlaneError, ControlPlaneUsageError } from './transport.js';
export type { ControlPlaneTransportOptions, ControlPlaneErrorDetail } from './transport.js';
export { ControlPlaneClient } from './client.js';
export type { ControlPlaneClientOptions, ClientProvisionScopeInput } from './client.js';
export { identityTenant, identityTenantsResponse } from './identity-tenants.js';
export type { IdentityTenant } from './identity-tenants.js';
export { DEV_ACTOR_HEADER, SERVICE_TOKEN_HEADER, TENANT_HEADER } from './headers.js';
export { ControlPlaneBuilderClient, WALK_PAGE_LIMIT, walkPages } from './builder-client.js';
export type { PageRequest } from './builder-client.js';
export type * from './builder-types.js';
