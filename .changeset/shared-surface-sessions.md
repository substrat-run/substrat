---
'@substrat-run/vertical-auth': minor
'@substrat-run/demo-meridian': patch
---

Shared login across a scope's surfaces (K-26 multi-surface): a delivered
`substrat:auth.cookieDomain` sets the session cookie with `Domain=<parent>` instead of
host-only, so sibling surfaces (`crm.egeryds.se`, `eka.egeryds.se`, …) share one session.
The signing secret was already per-tenant (DO-minted), so the attribute is the only thing
that was missing. Both providers honor it — the OIDC relying party directly, Better Auth
via `advanced.crossSubDomainCookies` (the worker relays the choice to the IdentityDO as a
header, re-validated there). `resolveCookieDomain` validates the domain against the
request host where the cookie is set (equal or proper-suffix at a label boundary, no bare
TLDs); an invalid domain degrades to host-only rather than breaking sign-in. Setting the
domain cookie also clears the host-only shadow, and logout clears both variants. Meridian
threads `cookieDomain` through its `authChoice` as the reference wiring.
