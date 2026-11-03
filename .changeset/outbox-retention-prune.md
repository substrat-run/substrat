---
'@substrat-run/kernel': minor
'@substrat-run/contracts': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': minor
---

The event drain now prunes a scope's outbox: a row drained to the lake more than 90 days ago is deleted once every local consumer of its type has taken it, unless its type is exported to another vertical or it is its entity's newest event. History reads cover that window and older history is in the lake; a scope walk resumed below the pruned range refuses with `WatermarkPruned`, so a mirror resyncs. A consumer added later backfills only the retained window. Scopes that never drain are never pruned.
