---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
---

A connection can be owned by one scope: the connection relay's upsert takes `owner: 'scope'`, and the scope's connection is keyed apart from the tenant's and every other scope's, so two scopes can connect the same account. `Connection.ownerScopeId` names the owner (`null` for a tenant-owned connection), `listConnections` filters by it, and `openConnection` opens a scope's own connection only when its owner is named. The connector pass never lands a scope-owned connection. Tenant-owned connections behave exactly as before.
