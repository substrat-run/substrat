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
- kernel: `HostAdmin.markScopeProvisioned` takes an optional `ReconcileOutcome` (`{ retirementsFinished }`) and writes both columns in one write. `PROVISIONED_VERSIONS_SQL` groups by (version, finished); `installReconciled` makes one install's group. The sweep's `reconcileScopeFn` may resolve a `ReconcileOutcome`, and an install whose retirements did not finish is behind.
- adapters: a directory migration adds `scopes.retirements_finished_version_id` (nullable, no backfill: every existing install reconciles once more). The hosted `provisionScopeLocal` returns `retirementsLeftOpen` when it reconciled shapes; a kill switch clears both columns.
- vertical-host: `/internal/reconcile` answers `retirementsLeftOpen`. A vertical built on an older vertical-host reports nothing, which the platform counts as not finished for a version that retires a key, so push a version built on this one before dropping a shape you retired.
- control-plane-api: `reconcileOutcomeOf`, and the reconcile and provision routes record the outcome.
