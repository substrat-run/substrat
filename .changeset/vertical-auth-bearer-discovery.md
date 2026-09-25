---
"@substrat-run/vertical-auth": patch
---

The bearer path (`@substrat-run/vertical-auth/oidc`) now looks its signing keys up through `oidc-rp`'s bound discovery instead of a second, unchecked one: the document must name the configured issuer, a redirect off the issuer's origin is refused, and a failed lookup is retried rather than remembered for the isolate's life. A delivered `substrat:auth` with a plaintext (non-loopback `http`) issuer no longer parses, so it reads as nothing delivered.
