---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
---

A scope dump carries its scope stores. `exportScope` calls `substrat.export` on each binding, and `importScope`, `restoreScope` and `snapshotScope` call `substrat.import`. A dump that names a binding the host does not have is refused before anything is written. `reapScope`, `deleteSnapshot` and a hosted scope delete call `substrat.wipe` before the scope's own storage goes. A backup copies the stores unsealed — they are opaque, so an erasure does not reach the copy already in the backup — and a masked tenant export omits them.
