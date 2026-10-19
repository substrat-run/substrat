---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/contract-tests': patch
---

A scheduled pass now reports the platform requests its schedules enqueued, and a sweep that drains platform requests drains that scope again in the same pass, so a scheduled send goes out in seconds instead of waiting for the next sweep (#2431).

- `ScheduleRunReport` gains an optional `platformRequests`: how many `ctx.requestPlatform` calls the pass's fires committed. A fire that throws rolls its requests back, and they are not counted. It is absent when the pass enqueued none. Both adapters fill it. A purge horizon's runs are not counted yet: what a purge enqueues waits for the next drain, as before.
- `runPlatformSweep` drains a scope once more, right after its schedules, when they report requests and `drainPlatformRequestsFn` is set. It does so once per scope, only for a scope the drain phase reached, and never fires a schedule from it. The drain before the schedules stays where it was, so a schedule still finds the scope's whole headroom under the 32-request cap. In `platformRequestTotals`, a scope drained twice adds what each drain did, while `pending` and `unsettleable` are its later drain's. An intent the first drain left pending is tried again by the second. `ScheduleSweepReport` gains an optional `platformRequests` total.
- A hosted vertical's scope sweeper has no channel to the platform's drain, so what its schedules enqueue still waits for the control plane's sweep. Its pass report now counts those requests (`schedules.platformRequests`), and the sweeper the platform supplies to a vertical logs a `scope-sweep` line with the pass's counts when there are any. A vertical gets that sweeper at its next push after the control plane carrying this release is deployed.
- `SqliteScopeHost.getSystemScope` takes optional stub observers, as `getScope` does.
- `@substrat-run/contract-tests` adds `schedulePlatformRequestsContractSuite`, which both adapters run.
