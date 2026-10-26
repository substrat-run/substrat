---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': patch
---

A serve records its serving state only while the row still holds the state its upload was computed from (#2577).

- **`expected`.** `HostAdmin.setVerticalServing` takes an optional trailing `expected`, the serving state the caller read before its upload (null: nothing served). A row whose DO class set or migration tag no longer matches it is refused `precondition_failed` (`servingRaceRefusal`) before the #2178 gate, and nothing is written: those two are what the upload's migration was diffed from. Its ref and version are not compared, so a serve recorded meanwhile that moved only those is recorded over, as before. The control-plane serve passes what it read before uploading, so a serve that changed the class set during another serve's upload is no longer overwritten by a record diffed from the state before it.
- **The class set and tag in the compare-and-set.** The compare-and-set on the host's own read now holds the DO class set and migration tag as well as the serving ref and version. A serve of a version that adds a class and a re-serve of the old version bring the ref and version back over a grown class set, and a record diffed from before them named classes and a tag the script no longer had, so the next upload re-declared a live class under a tag the runtime refuses.
- **No retry.** As before, a refused serve has already uploaded the serving script. The promote answers that the in-place serve failed and to promote again, no longer adding that scopes still run the previous code, which is false after the upload. When the refused serve's own upload added a class, the runtime's tag is already past the record's and a retry cannot land: the promote says so instead (`promoting again cannot land until the record is repaired`). Two overlapping serves that both change the class set end there; only serialising serves would avoid it.
- **Version skew (adapter-cloudflare).** The ControlPlaneDO's `setVerticalServing` keeps its name. Its `expected` gains optional `doClasses` and `migrationTag`: a coordinator from before sends the ref and version alone and gets the compare-and-set it had, and a DO from before ignores the two fields, so for the rollout window the class set and tag go unchecked and nothing is weaker than before. A new method name would have failed closed only after the upload had landed.
- **kernel.** `migratesFrom` (the `expected` check) and `servesAsFrom` / `servedFromRow` (the compare-and-set in the unit that writes), run by both adapters.
- **contract-tests.** The case on both adapters.
