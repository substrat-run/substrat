---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

A purge pass no longer fails the entities its scope's pending-request cap turns away (#2506). A pass takes up to 50 entities, and a scope holds at most `MAX_PENDING_PLATFORM_REQUESTS` (32) pending platform requests, so a purge operation enqueuing one request per entity used to fail from the 33rd. `ctx.requestPlatform` now refuses a full queue with `PlatformRequestBackpressureError`, still an `Error` with the message it always had, and `runPurgePass` treats that refusal as "not yet": the batch stops, the lap resumes at that entity after the drain, and nothing is reported failed. A pass that cannot purge its first entity closes its lap with one reported error and waits its cadence. Additive only: `PlatformRequestBackpressureError` and `assertPlatformRequestRoom` are new exports, and `PurgeDue` gains an optional `keys`.
