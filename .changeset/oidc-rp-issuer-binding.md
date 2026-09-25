---
"@substrat-run/oidc-rp": patch
---

`oidc-rp` now holds a discovery document to what it is trusted with.

- The configured issuer must be `https` (or a loopback `http` issuer, for a dev issuer), and a plaintext one is refused before any request is made. Issuers compare as URLs: host case and a default port do not matter, one trailing slash is ignored, and the path stays case-sensitive.
- The document must state the issuer it was fetched for (OIDC Discovery §4.3), and a refusal is not cached.
- `jwks_uri` must be `https`, and a plaintext UserInfo endpoint is skipped. The token endpoint must be `https` too, but may sit on another origin than the issuer.
- The token POST and the UserInfo request no longer follow redirects, so a 30x fails the login instead of carrying the client secret or bearer onward.
- The discovery fetch follows a redirect only while it stays on the issuer's origin, for at most three hops, and fails with a distinct message for a loop, a missing `Location` and an off-origin target.
- New `@substrat-run/oidc-rp/discovery` subpath exports `discoverIssuer` and `isHttpsOrLoopbackUrl`, with no login flow and no `hono`.

**Check before release:** a team auth-server whose `PUBLIC_ORIGIN` is set to a host other than the issuer hostname its verticals are configured with will now fail every login bound to it, because its discovery document names a different issuer.
