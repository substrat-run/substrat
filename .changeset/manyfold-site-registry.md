---
'@substrat-run/vertical-auth': minor
'@substrat-run/demo-manyfold': minor
---

Manyfold multi-scope, M2: a per-tenant site registry so the app lists and switches its sites.

The per-tenant `IdentityDO` gains a site registry (`recordSite` / `listSites` /
`resolveSiteScope`, logic factored into `site-registry.ts` so it is unit-testable without a
Durable Object). Manyfold's worker records each site at `/internal/provision`, serves the
tenant's sites at `GET /api/sites` (previously 404 in production, which left the switcher
empty), and resolves the app's `x-site` slug selection to the corresponding scope in `nodeFor`
— so the existing in-app site switcher now actually switches sites on a deployed install.
`nodeFor` is split from a sync `baseNode` (the routed tenant + home scope, which the auth
provider keys on) so the async site resolution never touches the auth path. Tenant isolation is
unchanged: the registry is per-tenant and `getScope` re-checks the (tenant, scope) pair.
