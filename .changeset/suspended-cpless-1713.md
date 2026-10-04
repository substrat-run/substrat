---
'@substrat-run/contracts': patch
'@substrat-run/kernel': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/vertical-host': patch
'@substrat-run/control-plane-api': patch
---

Suspending a scope or a tenant now stops a hosted vertical's own work on it, not only its requests (#1713). Until now the router refused a suspended scope's requests, but the vertical's sweeper, retries and job runner never pass the router, so a suspended scope kept firing its schedules and running its deliveries.

**The platform delivers the lifecycle.** After a scope transition (suspend, unsuspend, archive, unarchive) or a tenant status change, the control plane posts the scope's state to the deployment that serves it, at the new `/internal/lifecycle` route: `{ scopeId, lifecycle: { scope, tenant, at } }` (the new `scopeLifecycle` contract), answered with a `lifecycleDelivery`. A tenant change goes to every hosted scope under the tenant. A live scope whose deployment already runs it live is not posted to, so an activation changes nothing on the wire. The scope stores the newest state it has seen, ordered by `at`, so a late delivery cannot undo a later one.

**One gate, deferred rather than dropped.** A CP-less `CloudflareScopeHost` checks the stored state at every door that runs a scope's work: `getScope`, attachments, capability, impersonation and peer doors, subscriptions, `getSystemScope`, `drainDue`, `startJobRun`, `runDueJobs`, `dispatchConnector`. A held scope is refused in the same words the directory uses (`scope not active (status: suspended)`, `tenant not active (status: …)`). The deferring entry points leave everything due:
- The sweeper skips a held scope whole and counts it in `ScopeSweepReport.held`.
- `runDueSchedules` reports `lifecycleHeld` with every schedule `skipped` and moves no cadence row.
- `checkFreshness` judges nothing.
- The executor drain attempts nothing (`ExecutorDrainReport.lifecycleHeld`).

Unsuspending resumes all of it on the next pass, once. An operator's reads (dead letters, job runs, platform requests, delivered grants) still work on a held scope.

**A missed delivery heals.** A delivery that fails never blocks the transition. It lands as an ops-failure row (`scope.lifecycle` / `deliver`). The directory records what each deployment acknowledged in a new `scope_lifecycle_receipts` table. On every cron pass, `CloudflareScopeHost.healLifecycles` re-delivers to every hosted scope whose receipt differs from the directory, and again to every scope held now. A restore of a backup taken before a suspension does not lift it, and a copy never inherits its source's state. A scope that has never received a lifecycle runs as before.

Re-push every vertical after this release so its deployment carries `/internal/lifecycle`. Until then, a delivery to it fails and is retried by the heal pass. The platform intents of a suspended hosted scope (connector deliveries the control plane drains) are not yet deferred; that is a separate change.
