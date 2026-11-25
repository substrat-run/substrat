---
'@substrat-run/demo-auth-server': minor
---

An issuer can delete what has expired: sessions, OAuth access and refresh tokens, sign-in challenges and client-assertion markers, once each is past its expiry plus a grace (`PRUNE_GRACE_HOURS`, 24 by default). Off unless `PRUNE_EXPIRED` is set: `count` logs what would be deleted and deletes nothing, `on` deletes in small batches from the issuer's own timer. A session is kept while any token still names it, and a refresh token while an access token or its rotation window does. Adds `expires_at` indexes to those tables, built once on the first start after the deploy.
