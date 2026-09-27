---
'@substrat-run/contracts': patch
---

`sweepRunsPayload` now refuses any entry whose `kind` is not `schedule` or `freshness`, instead of naming the three other kinds one by one. A scope-drained sweep batch only ever legitimately carries those two, so a kind added to `sweepRunKind` later is refused by default rather than silently accepted from a scope batch.
