---
'@substrat-run/contracts': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
'@substrat-run/vertical-host': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/control-plane-client': patch
'@substrat-run/cli': patch
---

A scope dump carries each module table's own indexes and guard triggers, and a restore puts them back, so a module's own invariants come back with a restore; the restore's admin row says what was carried and which triggers were left out.
