---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': minor
---

A binding shape whose `bind` a version dropped stays guarded: a later version may not remove it, move its holder, or drop one of its keys unretired while any install has people bound through it (#2184).

Dropping `bind` stops new links and leaves the people already bound holding the shape. The binding-shape gate judged only the registry's `bind`, so once a version dropped it, a later version could remove the shape and strand them. Each install's reconcile now reports the binding shapes links have ever bound in it (the scope's sticky `shape-bound` records), the directory records them beside the receipt, and the gate counts a bootstrap shape with a table holder as binding wherever an install bound it.

- contracts: `bindingShapeBreaks(from, to, boundEver?)` and `assertNoBindingShapeBreak(…, { boundEver })`; `mayHoldBound(shape)`. `Scope.boundShapes` (`{ versionId, types }`, counting only while `versionId` is the receipt's).
- kernel: `topUpEntityGrantShapes`'s last pass answers `boundEver`. `ReconcileOutcome.boundShapes`, written by `markScopeProvisioned` in the same write as the receipt. `PROVISIONED_VERSIONS_SQL` groups by the reported set too (rows stay per version and set, not per install); `boundEverOf`, `boundShapesColumn`, `boundShapesOfColumn`. An install that has not reported is behind, in the same share of the sweep's window as one behind on its retirements, and **a `reconcileScopeFn` must now resolve `{ retirementsFinished, boundShapes }`** for an install to stop being reconciled each pass.
- adapters: a directory migration adds `scopes.bound_shapes` (nullable, no backfill: every existing install reconciles once more, and until it does it is judged as having bound every table-held bootstrap shape of its version). The hosted `provisionScopeLocal` (adapter-cloudflare) answers `boundShapeTypes` whenever it reconciled shapes; a kill switch clears the column with the receipt.
- vertical-host: `/internal/reconcile` answers `boundShapeTypes`. As with the retirement count, a vertical needs **both** packages at this release to report it; a version with no bootstrap shape held by a table needs neither.
- control-plane-api: `reconcileOutcomeOf` reads the answer, keeping the types of the sent shapes held by a table.
