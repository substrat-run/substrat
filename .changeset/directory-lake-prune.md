---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
---

The directory can prune a captured data set to its 35-day window once the lake provably holds the rows (K-70), behind a switch that is off by default and only for data sets whose history is read from the lake.
