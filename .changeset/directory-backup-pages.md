---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/control-plane-api': minor
---

The scheduled directory backup reads and stores the directory a page at a time, so a directory larger than its Durable Object's memory is backed up again, and a failed copy is retried after six hours rather than on every sweep. Contracts adds `directoryDumpPage`; `HostAdmin` gains an optional `exportDirectoryPage`; `DirectoryBackupStore` replaces `put` with `begin` (a breaking change for a store implemented outside this repo) and notes attempts. Copies stored whole before this still read.
