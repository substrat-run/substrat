---
'@substrat-run/contracts': patch
'@substrat-run/contract-tests': patch
---

Routing schemas accept prefixed vertical registry ids: `hostnameBinding.verticalSlug`
and `routeTarget.verticalSlug` now use the `verticalSlug` schema
(`<tenantSlug>/<name>` or bare) instead of the bare `slug` pattern. Before this, an
installed builder vertical's hostname row failed the Zod boundary on read-back, so
the bind was silently discarded and the app ended up with no URL.
