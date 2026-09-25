---
"@substrat-run/demo-auth-server": patch
---

A custom (generic OIDC) sign-in provider's discovery document is read with `@substrat-run/oidc-rp`'s rules when the provider is saved. Its authorization, token, UserInfo and end-session endpoints are judged against the issuer: plaintext is allowed only on loopback, and only when the issuer is itself a loopback dev issuer. A `jwks_uri` is required and held to the same rule. The discovery fetch follows a redirect only while it stays on the issuer's origin. An issuer URL carrying credentials is refused, and the refusal no longer repeats the URL. Providers saved earlier keep their stored endpoints until the issuer is changed and saved again.
