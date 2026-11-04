---
'@substrat-run/control-plane-api': minor
---

A backup, a restore and a snapshot move a scope store a page at a time: a backup holds each store's pages as entries named in its manifest's `storeEntries`, a restore stages every store before it loads the scope and commits them after, and a snapshot stages the fork's stores from the source's. Backups with stores inline still restore. `PlatformScopeStores` replaces `exportStores` and `importStores` with `callStore` (a breaking change for a caller implemented outside this repo), and `ScopeBackupWriter.commit` takes `storeEntries`.
