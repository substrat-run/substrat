---
"@substrat-run/oidc-rp": patch
---

`@substrat-run/oidc-rp/discovery` exports `readDiscovery(issuer, { fetch, signal })`: one uncached read of an issuer's discovery document under the same rules `discoverIssuer` applies (an `https` or loopback issuer, same-origin redirects only, the issuer the document states must be the one asked for, and `authorization_endpoint`, the token endpoint and a required `jwks_uri` held to `isAllowedEndpoint`). It takes an injected fetch and an abort signal that applies to every hop, and returns the whole document so a caller can read a field such as `registration_endpoint`. `discoverIssuer` is now this read, cached as before. The read sends `accept: application/json`.

Also exported: `sameIssuer(a, b)`, the issuer comparison discovery uses (parsed URLs, so host case, a default port and one trailing slash do not matter; never true for an identifier with a query, fragment or userinfo).
