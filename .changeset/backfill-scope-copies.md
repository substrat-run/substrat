---
"@substrat-run/kernel": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/contract-tests": patch
"@substrat-run/control-plane-api": patch
---

Backfill the copy ledger with the per-script scope copies made before it existed. A staff route (`POST /scope-copies/backfill`) walks the admin log page by page, a dry run unless told otherwise, and records each script a scope was routed to and the ledger does not yet name as `retained`, so reap and erasure reach it. It never wipes or deletes anything. A log row it cannot resolve to a script, or a scope whose directory row is gone, is reported as a failure and recorded in the ops log, and is never marked clean.
