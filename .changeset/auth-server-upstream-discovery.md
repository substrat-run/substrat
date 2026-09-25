---
"@substrat-run/demo-auth-server": patch
---

A custom (generic OIDC) sign-in provider's discovery document is read with `@substrat-run/oidc-rp`'s rules when the provider is saved. Its authorization, token, UserInfo and end-session endpoints are judged against the issuer: plaintext is allowed only on loopback, and only when the issuer is itself a loopback dev issuer. A `jwks_uri` is required and held to the same rule. The discovery fetch follows a redirect only while it stays on the issuer's origin. An issuer URL carrying credentials is refused, and the refusal no longer repeats the URL.

A stored upstream provider whose endpoints no longer meet the rule, or whose stored document names an issuer other than the configured one, is not offered for login until it is saved again. It gets no sign-in button, no mounted configuration and no account-linking trust. The providers panel marks it "not offered", says why without repeating a URL, and saving it again re-discovers its endpoints even when the issuer is unchanged. The providers list never shows credentials from a stored issuer URL.
