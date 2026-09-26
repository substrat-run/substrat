---
"@substrat-run/kernel": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/adapter-cloudflare": patch
---

The cross-vertical export read and the control plane's audit-log action filter keep their index once a scope or the directory has table statistics. After an `ANALYZE` (which a vertical's own SQL can run) the planner had stopped seeking `(type, id)` and walked the whole outbox tail for a rare event type; both reads now drive from the type list, so the plan is the same with or without statistics. The rows returned, and their order, are unchanged.
