---
"@substrat-run/dashboard": patch
---

Registering an app as a client of a team auth-server now reads the issuer's discovery document under `oidc-rp`'s rules: the document must come from the issuer's origin and name that issuer, and its `registration_endpoint` must be `https` (plaintext only for a loopback dev issuer). The registration request follows no redirect, so a 30x fails the install. A discovery document that cannot be read or is refused fails the registration; the default registration path on the issuer's own origin is used only when a valid document names no `registration_endpoint`.
