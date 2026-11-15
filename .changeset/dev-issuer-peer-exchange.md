---
'@substrat-run/dev-issuer': minor
---

The dev issuer issues a refresh token for `offline_access` and answers `grant_type=refresh_token` with a fresh id_token, and serves the one-step `peer` token exchange from grants passed as `delegations` (or `--delegations <module>`), so a master app can call its plugin as the signed-in person locally (#3161).
