---
'@substrat-run/contracts': patch
'@substrat-run/kernel': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/control-plane-api': patch
---

The scheduled directory backup reads and stores the directory a page at a time, so a directory larger than its Durable Object's memory is backed up again, and a failed copy is retried after six hours rather than on every sweep. Contracts adds `directoryDumpPage`; `HostAdmin` gains an optional `exportDirectoryPage`; `DirectoryBackupStore` writes through `begin` and notes attempts. Copies stored whole before this still read.
