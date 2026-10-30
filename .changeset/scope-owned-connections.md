---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
---

The connection store can hold a connection owned by one scope, keyed apart from the tenant's and every other scope's, so two scopes could each hold their own connection to one account. `Connection.ownerScopeId` names the owner (`null` for a tenant-owned connection), `createConnection` takes it, `listConnections` filters by it, and `openConnection` opens a scope's own connection only when its owner is named. The connector pass never lands a scope-owned connection. Tenant-owned connections behave exactly as before, and the connection relay still makes only tenant-owned ones.
