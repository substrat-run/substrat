---
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
'@substrat-run/dashboard': patch
---

Tenant tokens can carry an `issuerConfig` claim (`POST /tenant-tokens` takes `issuerConfig: true`), and with `requireIssuerConfigClaim` on, `/configure` refuses the issuer-only config keys (delegations, places, resources, redirects, an app's `substrat:auth`) from a tenant credential minted without it, with a 403 naming the prefix (#3177). The dashboard mints with the claim. The control plane's `CONFIGURE_REQUIRE_ISSUER_CLAIM` switch ships off: turn it on once this dashboard is deployed, so no isolate is still holding a token minted before it.
