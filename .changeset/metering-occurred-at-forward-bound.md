---
'@substrat-run/engine-metering': minor
---

`metering/record` now bounds `occurredAt` on both sides. It already refused an instant behind the close horizon; it now also refuses one more than five minutes ahead of the operation's own instant, with a new `occurred_at_ahead` conflict reason. The close horizon only ever advances, so an entry post-dated past it was aggregated into no period and left the billing stream with no error raised anywhere.

**This tightens what the operation accepts.** Nothing in this repo sends `occurredAt` at all — every caller defaults to `ctx.now()` — but a vertical that records usage with a caller-supplied future instant will start receiving a `conflict`. Recording at observation time, which is what the horizon rule already asked for, is unaffected; so is back-dating inside the open period, and so is a replay on an existing `dedupeKey` (answered from the existing row before either bound is consulted).
