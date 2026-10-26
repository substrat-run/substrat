---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': patch
---

A serve records its serving state only while the row still holds the state its upload was computed from (#2577).

- **`expected`.** `HostAdmin.setVerticalServing` takes an optional trailing `expected`, the serving state the caller read before its upload (null: nothing served). A row that no longer holds it is refused `precondition_failed` (`servingRaceRefusal`) before the #2178 gate, and nothing is written. The control-plane serve passes what it read before uploading, so a serve that lands during another serve's upload is no longer overwritten by a record diffed from the state before it.
- **The class set and tag in the compare-and-set.** The compare-and-set now holds the DO class set and migration tag as well as the serving ref and version. A serve of a version that adds a class and a re-serve of the old version bring the ref and version back over a grown class set, and a record diffed from before them named classes and a tag the script no longer had, so the next upload re-declared a live class under a tag the runtime refuses.
- **No retry.** As before, a refused serve has already uploaded the serving script. The promote answers that the in-place serve failed and to promote again.
- **Version skew (adapter-cloudflare).** The ControlPlaneDO's `setVerticalServing` keeps its name. Its `expected` gains optional `doClasses` and `migrationTag`: a coordinator from before sends the ref and version alone and gets the compare-and-set it had, and a DO from before ignores the two fields, so for the rollout window the class set and tag go unchecked and nothing is weaker than before. A new method name would have failed closed only after the upload had landed.
- **kernel.** `servesAsFrom`, `servedFromRow` and `servedFromState`, the comparison both adapters run in the unit that writes.
- **contract-tests.** The case on both adapters.
