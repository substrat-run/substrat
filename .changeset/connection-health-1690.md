---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
---

Staff can read every tenant's connection health in one call.

`@substrat-run/contracts` adds `deriveConnectionHealth`, which turns a connection's recorded outcomes (`lastOkAt`, `lastErrorAt`, `status`) into one of `healthy`, `erroring`, `stale` or `never-used`. A connection with no recorded outcome is `never-used`, never `healthy`. It is `stale` once its last success is `CONNECTION_STALE_DAYS` (7) old. `deriveExpiryWarning` flags a known grant expiry within `CONNECTION_EXPIRY_WARNING_DAYS` (7). `toConnectionHealthEntry` projects a connection onto an explicit allow-list of fields (`connectionHealthEntry`, strict), so neither a credential nor `createdBy` or `scopes` can reach the row.

`@substrat-run/control-plane-api` adds `GET /connections/health`, a staff and service read. Tenant and builder credentials are refused. It filters by `status` (the derived state), `provider` and `tenantId`, and is cursor-paged. The response carries the summary counts, the stale and expiry windows it used, and connector dead letters counted per provider over the last seven days from the ops-failure record. A count that reaches the read's bound is marked `capped`.
