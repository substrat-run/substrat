---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

A purge pass no longer fails the entities its scope's pending-request cap turns away once the pass is past its first entity (#2506). A pass takes up to 50 entities, and a scope holds at most `MAX_PENDING_PLATFORM_REQUESTS` (32) pending platform requests, so a purge operation enqueuing one request per entity used to fail from the 33rd. `ctx.requestPlatform` still refuses a full queue with a plain `Error` and the message it always had, but the kernel now knows which `Error` it threw, and `runPurgePass` defers that purge rather than failing it: the batch stops, and the lap resumes at that entity on the next pass. A refusal at the first entity of a pass is an ordinary failure, as before, and so is every refusal after it in that pass (those entities stay in the bin and are retried on the next lap), so a purge that can never fit cannot hold the head of the walk. Additive only: `assertPlatformRequestRoom` is a new export, and `PurgeDue` gains an optional `keys`, used only when parallel to `ids`.
