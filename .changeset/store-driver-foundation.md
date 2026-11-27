---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane-client': minor
'@substrat-run/cli': minor
'@substrat-run/control-plane': patch
---

A store-driver approval names the release's foundation version beside its schema (#3175). This is for a driver that rewrites its level-0 foundation in place when it wakes a store. `substrat store-driver approve` takes `--foundation <n>`, the approval records it and keeps it fixed for those bytes, and the approval result and `store-driver status` show it beside the current good release's. `substrat.selfcheck` may answer `foundation`, and the canary refuses a release whose reported foundation differs from the approved one. A rollout, rollback, return or script build that would lower the foundation a script runs is refused, as it is for the schema. A driver with no foundation leaves the field out.
