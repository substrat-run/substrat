---
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
---

Ops failures, sweep runs and the model-usage ledger can read history before the directory's 35-day window from the lake (K-70), on the same switch as the admin log (`DIRECTORY_LAKE_READS`, off by default, with a compare mode).
