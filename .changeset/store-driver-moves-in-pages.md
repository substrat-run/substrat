---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
---

A store driver's dump moves in pages (D-69). The reserved operations `substrat.export` and `substrat.import` are removed, and `substrat.export-page`, `substrat.stage-page`, `substrat.commit-stage` and `substrat.discard-stage` take their place. A chain of pages is one moment, told by an opaque `revision`, and the commit is the only step that changes the object. A registration declares `dumpPageMaxBytes`, the largest page its driver takes, at most `STORE_DUMP_PAGE_MAX_BYTES` (3 MiB); one served by a plane that predates it parses, and `servedStoreDriverRegistration` reads a plane's registry dropping keys it does not know. The canary loads the release's fixture (`storeCanaryFixture`, a store dump of at most `STORE_CANARY_FIXTURE_MAX_ROWS` rows) as a stage of several pages through `writeStoreDumpPages` and reads it back through `readStoreDump`. The kernel exports `readStoreDump`, `writeStoreDump`, `writeStoreDumpPages` and `storeDumpPages`; the canary and the runner suite check the new operations, and `counterScopeStoreRunner` is a paged driver.
