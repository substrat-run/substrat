---
"@substrat-run/dashboard": patch
---

An external OIDC issuer in an app's Identity choice must be `https` (or a loopback `http` issuer for local development). A plaintext issuer is refused when the choice is saved.
