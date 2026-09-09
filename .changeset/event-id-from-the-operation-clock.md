---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': minor
---

An event's id is now minted from the operation's instant instead of the wall clock,
so the id and the `occurredAt` beside it agree about when — barring a clock that runs
backwards, where the id holds at the last instant it stamped rather than let a newer
row sort underneath an older one. This matters because the outbox,
`readTimeline`/`readHistory` and `ctx.versionOf` all page by `ORDER BY id`
and treat the id as the cursor — the log was being ordered by a clock nothing else in
the operation used. `@substrat-run/kernel` gains `createUlid()` (a mint with its own
monotonic floor, which is what lets an injected clock reach an id) and `ulidTime()`,
which reads an id's instant back and refuses anything that is not a ULID. A mint now
also refuses an instant it cannot encode — before the epoch, past the year 10889, or
not a whole millisecond — instead of returning a string that is not an id.
`@substrat-run/contract-tests` exports `testMod`, the module its bare operations run
in, so a suite outside the shared ones can stand a scope up the same way.
