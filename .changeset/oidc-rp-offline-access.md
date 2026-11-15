---
'@substrat-run/oidc-rp': minor
---

`beginLogin` can ask for `offline_access`, and `completeLogin` returns the refresh token the issuer sends, giving the session a `sid` to keep it under when asked.
