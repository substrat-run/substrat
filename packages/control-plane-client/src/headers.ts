/**
 * The header names a caller and the control plane agree on. They live in the client
 * package because it is the side every caller can import without taking the server with
 * it; `@substrat-run/control-plane-api` re-exports them from its `auth.ts`, so the server
 * and the clients read one spelling (#971).
 */

/** Header the dev stub reads. Mirrors the demos' `x-principal` dev affordance. */
export const DEV_ACTOR_HEADER = 'x-platform-actor';

/** Header a SERVICE (a vertical registering itself) presents — not a staff subject. */
export const SERVICE_TOKEN_HEADER = 'x-service-token';

/**
 * Header naming the tenant a caller ACTS FOR. For a builder session it selects the
 * workspace (`--tenant`) the builder reader narrows to. For a staff/service caller it is
 * the slug-resolution pin (#417): vertical routes form `<tenantSlug>/<slug>` from it the
 * way a pinned push does, so `versions <bare> --tenant <t>` over a service token reaches
 * the same registry row a builder session would. It never widens access — staff reach
 * everything already, and for builders the tenant must be one of their memberships.
 */
export const TENANT_HEADER = 'x-substrat-tenant';
