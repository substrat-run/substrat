---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
---

The platform can call a scope store's reserved operations. `substrat.size` answers `{ bytes }`, `substrat.erase` takes `{ subjectId }` and answers `{ erased }`, `substrat.export` answers `{ tables }`, `substrat.import` takes `{ tables }`, replaces the object and answers how many tables it wrote, and `substrat.wipe` answers `{}`. `callReservedStoreOperation` is the only caller, and it refuses any other name. `HostAdmin.scopeStoreSizes` reads each declared binding and writes the access log. A dispatch vertical answers the same reading on `GET /internal/scope-store-sizes`.
