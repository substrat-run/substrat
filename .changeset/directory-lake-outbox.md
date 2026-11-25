---
'@substrat-run/kernel': minor
'@substrat-run/contracts': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane': patch
---

The directory gets an outbox to the lake for its own logs and meters (K-70): capture per data set, off by default, written in the same transaction as each row, drained by the scheduled pass, and a dry-run-first backfill of the rows it already holds.
