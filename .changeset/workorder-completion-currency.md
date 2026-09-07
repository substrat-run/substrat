---
'@substrat-run/engine-workorder': minor
---

`completeWorkOrder` takes an optional `currency`, so a completion with no billable lines no longer invents `SEK`. Omitting it keeps today's answer; declaring one that contradicts the billable lines is refused instead of ignored.
