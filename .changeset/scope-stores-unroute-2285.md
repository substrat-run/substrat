---
'@substrat-run/kernel': minor
'@substrat-run/control-plane': patch
---

A scope is taken out of routing before its stores are wiped (#2285). Subject erasure re-reads the scope's stores after erasing them and keeps the key when the set has changed, and the erasure claim also requires the serving version it read.
