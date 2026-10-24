---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

A purge schedule whose first entity is refused only because another schedule of the same scheduled tick filled the scope's pending-request cap now retries on the next tick instead of waiting its whole cadence (#2517). Nothing drains the scope between two schedules of a tick, so that refusal was the tick's own queue, not a standing one, yet it was recorded as a failed run. The pass now tries nothing, leaves the lap as it was and keeps the schedule due; the next tick, after the drain, tries the same entity again. It needs an earlier schedule of that tick to have enqueued a request, so a queue other traffic filled still fails the first entity as before, and a refusal never holds the head of the walk (#2096). Additive only: `runPurgePass` takes an optional `earlierRequests`, and the Durable Object's `runPurgeSweep` an optional trailing argument that an older scope ignores.
