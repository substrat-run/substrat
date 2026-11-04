---
'@substrat-run/dev-issuer': patch
---

`/userinfo` refuses a missing or invalid bearer as an `application/problem+json` document with a `WWW-Authenticate: Bearer error="invalid_token"` challenge; the OAuth token errors keep their RFC 6749 shape.
