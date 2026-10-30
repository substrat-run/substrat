---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
---

A scope can make, bind and unbind its own connection through the connection relay. The upsert takes `owner: 'scope'` for a provider the scope's running version lands `on-request` and whose connector opens a scope's own connection. `relayConnectionBind` and `relayConnectionUnbind` (`/internal/connections/bind` and `/unbind`) bind that connection to that scope alone, with the scope's own options validated by the connector, and take the binding and its key back again. A vertical-defined connector's routed event is handed its scope's own connection when it holds one. The kernel exports `onRequestLandingFor` and `binderOf`, `ConnectionBinder` gains `unbind`, `revokeFromConnection` takes an optional `revokedBy`, and the binding audit an optional `requestedBy`.
