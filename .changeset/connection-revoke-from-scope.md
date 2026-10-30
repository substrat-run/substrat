---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
---

`HostAdmin.revokeFromConnection` takes one key back from a live connection on one scope, the inverse of a scope-level `grantToConnection`: the scope's grant tuple goes first, then the directory record is tombstoned so no reconcile delivers it again, and the action is audited only when something changed. Hosted, the tuple is removed through the new `/internal/connector-revoke` route of the deployment serving the scope; a deployment on an older `@substrat-run/vertical-host` cannot take it, and the call refuses with `ConnectorRevokeUnsupported` without changing anything. `ConnectionInspector.unbindScope` drops a connection's binding to one scope.
