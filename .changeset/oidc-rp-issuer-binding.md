---
"@substrat-run/oidc-rp": patch
---

`oidc-rp` now holds a discovery document to what it is trusted with.

- The configured issuer must be `https` (or a loopback `http` issuer, for a dev issuer), and a plaintext one is refused before any request is made. An issuer identifier with a query, fragment or userinfo is refused. Issuers compare as URLs: host case and a default port do not matter, one trailing slash is ignored, and the path stays case-sensitive.
- The document must state the issuer it was fetched for (OIDC Discovery §4.3), and a failed or refused discovery is remembered for 30 seconds (`DISCOVERY_FAILURE_TTL_MS`), so a broken issuer costs one fetch per window rather than one to four per request.
- `jwks_uri`, the token endpoint and the UserInfo endpoint must be `https`, and the token endpoint may sit on another origin than the issuer. A plaintext loopback endpoint is accepted only when the configured issuer is itself a loopback `http` issuer, so an `https` issuer's document cannot name one. A plaintext UserInfo endpoint is skipped, and the id-token hint is withheld from a plaintext end-session endpoint.
- The token POST and the UserInfo request no longer follow redirects, so a 30x fails the login instead of carrying the client secret or bearer onward.
- The discovery fetch follows a redirect only while it stays on the issuer's origin, for at most three hops, and fails with a distinct message for a loop, a missing `Location` and an off-origin target.
- New `@substrat-run/oidc-rp/discovery` subpath exports `discoverIssuer`, `issuerRefusal`, `isAllowedEndpoint` and `isHttpsOrLoopbackUrl`, with no login flow and no `hono`.

**Check before release:** a team auth-server whose `PUBLIC_ORIGIN` is set to a host other than the issuer hostname its verticals are configured with will now fail every login bound to it, because its discovery document names a different issuer.
