---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
---

The snapshot taken before an update now expires after 30 days, and the scheduled sweep deletes it, so these copies no longer pile up. Platform staff can move or pin a copy's expiry with `PUT /tenants/:t/scopes/:s/expires-at`.
