---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': minor
---

A binding-shape drop now waits for the retirement to have finished in every install, not only for each install to have reconciled the retiring version (#2185).

A reconcile that gave a retirement up (`retirementsLeftOpen`) used to write its receipt all the same, and its answer about retirements never reached the control plane, so the install read as done and the retirement was never run again. The reconcile now reports how many retirements it left open, and the directory records, beside the receipt, the version whose retirements finished in that scope. The gate judges an install whose retirements did not finish as still holding the keys its version retires, and the sweep counts it behind, so the next pass runs the retirement again.

- contracts: `retiredKeysOf(shape)`, the keys a retirement takes back, reused by the kernel's reconcile and the gate. `Scope.retirementsFinishedVersionId`.
- kernel: `HostAdmin.markScopeProvisioned` takes an optional `ReconcileOutcome` (`{ retirementsFinished }`) and writes both columns in one write. `PROVISIONED_VERSIONS_SQL` groups by (version, finished); `installReconciled` makes one install's group. An install whose retirements did not finish is behind, and the sweep's window takes installs whose receipt is behind first, so one behind on its retirements alone never takes a provision repair's slot. **A `reconcileScopeFn` that resolves `void` now means "not finished, ask again"**: it writes the receipt with no finished version, so every install it reconciles stays behind and is reconciled on every pass. A host running its own sweep should resolve `{ retirementsFinished }`.
- adapters: a directory migration adds `scopes.retirements_finished_version_id` (nullable, no backfill: every existing install reconciles once more). The hosted `provisionScopeLocal` (adapter-cloudflare) counts `retirementsLeftOpen` whenever it reconciled shapes; a kill switch clears both columns.
- vertical-host: `/internal/reconcile` answers the count adapter-cloudflare's host returns. A vertical needs **both** packages at this release to report it: an older `@substrat-run/adapter-cloudflare` counts nothing and an older `@substrat-run/vertical-host` answers nothing, and either way the platform counts the retirements of a version that retires a key as not finished. Push a version built on current releases of both before dropping a shape you retired.
- control-plane-api: `reconcileOutcomeOf`, and the reconcile and provision routes record the outcome. A governed restore, and a kept copy restored forward, now clear the receipt (and the finished version with it), as a rewind already did: the data loaded may predate a reconcile, a finished retirement included, so the sweep reconciles the install again.
