---
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
---

Ops failures and sweep runs may be pruned to the directory's 35-day window once the lake holds them (K-70), now that their history readers read the lake; the prune stays off unless `DIRECTORY_LAKE_PRUNE` names them and reads are on.
