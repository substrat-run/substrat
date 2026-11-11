---
'@substrat-run/demo-auth-server': minor
---

An operator's app can read the issuer's people through a strict subset of the Auth0 Management API (`POST /oauth/token`, `GET /api/v2/users-by-email`, `GET /api/v2/users/{id}`), with `last_login` and `logins_count` kept for as long as the person exists, and when each application last got a token for them. Opt in by adding `read:users` to `MACHINE_SCOPES`.
