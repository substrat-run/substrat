---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': patch
---

`HostAdmin.putConnectorStateFenced(id, { key, expected }, writes)` writes a batch of connector-state rows only if one other row, the fence, still holds `expected`. The fence check and the writes run in one transaction on both scope hosts. A vertical connector's answer under a scope's state lease is now written fenced on that lease. A call that took the lease over can no longer have its writes interleaved with an earlier call's.
