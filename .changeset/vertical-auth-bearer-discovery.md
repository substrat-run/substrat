---
"@substrat-run/vertical-auth": patch
---

The bearer path (`@substrat-run/vertical-auth/oidc`) now looks its signing keys up through `oidc-rp`'s bound discovery instead of a second, unchecked one: the document must name the configured issuer, a redirect off the issuer's origin is refused, and a failed lookup is retried rather than remembered for the isolate's life. A delivered `substrat:auth` with a plaintext (non-loopback `http`) issuer now answers 503 (`AuthConfigError`) instead of building a provider that would send its client secret in the clear. It does not fall back to the deployment's default identity provider, and the same refusal applies to the deployment default issuer and to an issuer that is not a plain identifier. `authorizationServersOf` names none of those issuers. A `jwksUri` override is held to the same transport rule as a discovered `jwks_uri`.
