---
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
---

Each hand-written copy of the `_substrat_*` spine DDL now names its counterpart in the
other adapter, says that a new spine table or column has to be added on both sides, and
points at `pnpm lint:spine-ddl` as the gate that refuses a divergence — including the one
thing that gate cannot see, a table present on a single side. Comments only; no behaviour
change.
