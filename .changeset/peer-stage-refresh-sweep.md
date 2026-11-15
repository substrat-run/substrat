---
'@substrat-run/contracts': minor
'@substrat-run/vertical-auth': minor
---

Authentication diagnostics gain a `peer` stage: a call a master app makes for a person is recorded there, accepted or refused, apart from the ordinary bearer door. A master app's stored refresh tokens of expired sessions are now deleted, a bounded batch at each sign-in or token rotation; `sqlRefreshStore` takes `now`, `maxAgeMs` and `sweepBatch`.
