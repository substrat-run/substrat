---
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
---

Each hand-written copy of the `_substrat_*` spine DDL now names its counterpart in the
other adapter, says that a new spine table or column has to be added on both sides, and
points at `pnpm lint:spine-ddl` as the gate that refuses a divergence — along with what
that gate does not judge: a table present on a single side, which it reports as a note
because the adapters legitimately partition the spine differently, and triggers or CHECK
constraints, which it does not compare at all. Comments only in the adapters; no behaviour
change.

The gate itself grew the dimension those comments were overstating. It compared columns and
nothing else, while the DDL blocks it reads carry about twenty-five `CREATE INDEX`
statements each — so an index built on one side and not the other passed green, and so did a
`UNIQUE` constraint, which `PRAGMA table_info` cannot see. It now compares indexes and
foreign keys as well, read through `PRAGMA index_list`/`index_info` so the comparison is of
what the query planner has rather than of how the two files spell it, and its self-check
perturbs the new dimensions on every run like the existing ones.
