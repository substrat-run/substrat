---
"@substrat-run/kernel": patch
---

The cross-vertical export read keeps its `(type, id)` index once a scope has table statistics. After an `ANALYZE` (which a vertical's own SQL can run) the planner had stopped seeking that index and walked the whole outbox tail for a rare event type; the read now drives from the type list, so its plan is the same with or without statistics. The rows returned, and their order, are unchanged.
