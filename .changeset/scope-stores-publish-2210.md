---
'@substrat-run/contracts': patch
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/control-plane': patch
'@substrat-run/control-plane-client': patch
'@substrat-run/cli': patch
---

A store kind is published from its own workspace. The control plane keeps the bytes, the checksum and an audit row, canaries the first vertical, and rolls back to the previous release if a later one fails (#2297).
