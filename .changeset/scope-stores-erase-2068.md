---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
---

Subject erasure reaches scope stores. `shredSubject` calls `substrat.erase` after the scope-side redaction and before the subject key is destroyed, so a store that errors leaves the key and a retry converges. The receipt gains `storeErasures`. An orchestrated erasure asks the serving script once, on `POST /internal/scope-store-erase`, and passes that result into `finalizeSubjectShred`.
