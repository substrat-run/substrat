---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
---

A scope is taken out of routing before its stores are wiped (#2285). The snapshot delete, the preview reap and the sweeper's snapshot reap first decide every refusal they can (the reap claim, a copy the platform cannot reach, stores that cannot be named), then unbind every hostname of the scope, then wipe its stores, then delete it. A refused reap leaves the scope routed and untouched.

Subject erasure is fenced against a bind, a promote, a rollback or a serving re-upload that lands while the stores are erased. `@substrat-run/kernel` adds `SubjectErasureFence` and one shared claim (`SUBJECT_ERASURE_CLAIM_SQL`): it requires the scope's bound version, serving pin, erasure epoch, copy inventory and the serving pointer's exact (ref, version) pair to still be what the erasure read. `finalizeSubjectShred` takes it as `expected`, and `shredSubject` takes it as an optional `fence`, so the direct arm claims the same way, and a moved scope answers 412 with the key kept. `@substrat-run/adapter-sqlite` and `@substrat-run/adapter-cloudflare` take that claim, and `@substrat-run/contract-tests` holds both to it. `@substrat-run/control-plane-api` adds `unrouteScope`, `claimScopeScriptReap` and `drainScopeScriptCopies`.
