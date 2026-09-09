---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

An event's id is now minted from the operation's instant instead of the wall clock,
so the id and the `occurredAt` beside it can no longer disagree. This matters because
the outbox, `readTimeline`/`readHistory` and `ctx.versionOf` all page by `ORDER BY id`
and treat the id as the cursor — the log was being ordered by a clock nothing else in
the operation used. `@substrat-run/kernel` gains `createUlid()` (a mint with its own
monotonic floor, which is what lets an injected clock reach an id) and `ulidTime()`.
