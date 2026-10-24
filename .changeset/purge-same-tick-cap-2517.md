---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
'@substrat-run/control-plane-api': patch
---

A purge schedule whose first entity is refused only because purges run earlier in the same scheduled sweep filled the scope's pending-request cap now retries on the next sweep instead of waiting its whole cadence (#2517). Nothing drains a scope between its schedules within a sweep, across modules too, so that refusal came from the sweep's own queue, yet it was recorded as a failed run. The pass now tries nothing, leaves the lap as it was and keeps the schedule due. Its run is reported as deferred: counted in the new `ScheduleRunReport.deferred` and the sweep reports' `schedules.deferred`, and as `skipped`, never `fired`. Only purges count: a queue filled by an ordinary schedule, or by any other traffic, still fails the first entity as before, so a head is deferred only while the purges ahead of it keep committing requests, and one that can never fit fails on the first sweep where they do not. Additive only: `runDueSchedules` takes an optional fourth argument (`ScheduleTick`, the earlier modules' `purgeRequests`), which both sweepers now pass, the report carries `purgeRequests`, and the Durable Object's `runPurgeSweep` takes an optional trailing argument that an older scope ignores, failing such a head as before.
