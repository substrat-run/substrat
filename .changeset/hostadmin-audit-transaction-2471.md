---
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
---

Commit scope expiry changes, version binds (including private promotion rebinds), serving-reference moves, provision receipts, and preview copy keep-alives with their admin audit rows in one directory transaction. If the audit insert fails, the directory state remains available for a retry.
