---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/contract-tests': patch
'@substrat-run/docs': patch
---

A scheduled pass now reports the platform requests its schedules enqueued, and a sweep that drains platform requests drains that scope again in the same pass, so a scheduled send goes out in seconds instead of waiting for the next sweep (#2431).

- `ScheduleRunReport` gains an optional `platformRequests`, which both adapters fill. It is exactly what `onPlatformRequests` reports for each fire's invoke:
  - the `ctx.requestPlatform` calls the operation itself committed;
  - on Cloudflare, also the connector deliveries its tail routed to the platform.

  It does not count:
  - requests a consumer makes in the operation's tail;
  - requests of a fire whose invoke threw after the operation committed;
  - a purge horizon's runs.

  Whatever it does not count waits for the next drain, as before. The field is absent when the count is zero.
- `runPlatformSweep` drains a scope once more, right after its schedules, when they report requests and `drainPlatformRequestsFn` is set. It does so once per scope, only for a scope the drain phase reached, and never fires a schedule from it. The drain before the schedules stays where it was, so a schedule still finds the scope's whole headroom under the 32-request cap.
  - In `platformRequestTotals`, a scope drained twice adds what each drain did, while `pending` and `unsettleable` are its later drain's.
  - A second drain that reaches no deployment, or throws, leaves the first drain's figures standing. It is counted in `unreachable`, or recorded in `errors`, as a first drain would be, so the drain's totals read as a floor.
  - An intent the first drain left pending is tried again by the second.
  - `ScheduleSweepReport` gains an optional `platformRequests` total.
  - No sweep in this repository reaches the second drain yet: the control plane's sweep drains platform requests, but its host runs no schedules. A self-hosted sweep that does both gets it.
- A hosted vertical's scope sweeper has no channel to the platform's drain, so what its schedules enqueue still waits for the control plane's sweep. Its pass report now counts those requests (`schedules.platformRequests`), and the sweeper the platform supplies to a vertical logs a `scope-sweep` line with the pass's counts when there are any. A vertical gets that sweeper at its next push after the control plane carrying this release is deployed.
- `SqliteScopeHost.getSystemScope` takes optional stub observers, as `getScope` does.
- `@substrat-run/contract-tests` adds `schedulePlatformRequestsContractSuite`, which both adapters run.
- The book's sweep chapter (chapter 9) describes the second drain under the schedule phase.
