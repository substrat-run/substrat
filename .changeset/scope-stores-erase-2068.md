---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
---

Subject erasure reaches scope stores. `shredSubject` calls `substrat.erase` after the scope-side redaction and before the subject key is destroyed, so a store that errors leaves the key and a retry converges. The receipt gains `storeErasures`. An orchestrated erasure calls the stores once, through the platform's own path to the store script, and passes that result into `finalizeSubjectShred`.

Erasure fails closed (#2242). A scope that may hold a store has its stores erased, and one whose stores cannot be named or reached refuses the erasure (503) with the key kept. A Cloudflare host with no control plane, a store binding and no `scopeStores.vertical` refuses `unavailable` instead of answering an empty list. The control plane's rule is gated on the store-kind registry, so while no kind is registered erasure proceeds as before. `ControlPlaneApiOptions.storeKinds` names the registry a control plane judges against (`STORE_KINDS` by default).
