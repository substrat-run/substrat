---
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/adapter-sqlite': patch
---

The `_substrat_schedule_state` spine table now says what it actually holds. Since the
freshness evaluator landed it has carried two kinds of row — schedule operations keyed
`module/verb`, and freshness expectations keyed `freshness:<eventType>`, where
`last_run_at`/`last_status` mean the last *recorded* time and verdict rather than a run.
The bootstrap DDL comment on both adapters, the lazy-create sites, and the spine table
reference in the docs now state both shapes and why they cannot collide. No schema or
behaviour change.
