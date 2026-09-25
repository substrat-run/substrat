---
"@substrat-run/oidc-rp": patch
---

`oidc-rp` now binds the discovery document to the configured issuer. A document whose `issuer` is not the one it was fetched for (OIDC Discovery §4.3, ignoring one trailing slash) is refused, and is not cached. The token endpoint must be `https`, or `http` on a loopback host for a dev issuer. It is not required to share the issuer's origin. The token POST and the UserInfo request no longer follow redirects, so a 30x fails the login instead of carrying the client secret or bearer onward. The discovery fetch follows a redirect only while it stays on the issuer's origin.
