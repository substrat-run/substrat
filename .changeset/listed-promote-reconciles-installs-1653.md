---
'@substrat-run/kernel': minor
'@substrat-run/control-plane-api': patch
'@substrat-run/control-plane': patch
---

A promote of a listed vertical now re-runs provisioning on its installs, so what a new
version's `onProvision` sets up reaches the installs that already existed.

The sweep's provision reconcile (#1172) compared a scope's receipt with its bound version. A
listed vertical's promote re-serves every install in place but moves none of their version
pointers, which belong to each tenant and move when that tenant presses Update. So the phase
never saw those installs: a new service principal, a site registration or a place on the
sweeper roster never reached them. The phase now compares against the version that RUNS on
the scope (`runningVersionOf`): for a scope on its vertical's serving script, the version
the script serves. Tenants' version pointers are not touched, so Update is still offered.

- **Paced.** At most `provisionReconcileBatch` scopes per pass, default 50, set on the
  control plane as `PROVISION_RECONCILE_BATCH` (`0` pauses the phase). The rest are reported
  as `deferred` and reached on later passes. Each pass starts its window at a random point
  in the behind set (`provisionReconcileRng` injects it), so installs that fail every time
  cannot keep healthy ones waiting.
- **Forks never.** The phase keeps only primary scopes, via the now-exported
  `isPrimaryScope`: no `forkedFrom`, and not `kind: 'preview'`. A PR preview is a restored
  copy of production data.
- **`unsupported` apart from `failed`.** A vertical with no `/internal/reconcile` answers
  501. `reconcileScopeFn` may resolve `'unsupported'` for it, which is counted, reported with
  up to 50 scope ids, not marked and not listed as an error.
- **The receipt names what ran.** A reconcile records the version of the deployment it
  actually reached (`versionReachedAt`, from the rung of the resolution ladder that chose
  it). The console's **Re-run provisioning** records that. The sweep passes
  `reconcileScopeFn` the version it will record (`expected`), and the control plane refuses
  to reconcile through a deployment that runs anything else. If the serving ref doesn't
  resolve and the ladder falls back to the bound version's deployment, the scope never looks
  repaired while the served version's hook has not run.
