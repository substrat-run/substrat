---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
---

A scope's data now moves between scripts a page at a time, so `preview create` and a carry onto another version no longer fail once a scope passes 32 MiB (#2450). Before this, the whole scope crossed a Durable Object RPC (32 MiB per message) and two isolates (128 MB each) as one value.

- **Source.** `exportDumpPage` reads the dump in pages of about 4 MiB (`SCOPE_DUMP_PAGE_MAX_BYTES`):
  - each table in rowid order, in batches;
  - every table in some page, empty or not, so its schema always travels.

  Each page is read in one turn. The pages carry the store's write revision, and the copy is started again when it moves between pages. After three attempts it is refused with a 409 and nothing is moved.
- **Destination.** `stageDumpPage` keeps the pages in the store's own `_substrat_stage*` tables:
  - untyped, so every cell is kept as it arrived;
  - the load stamp and the write revision a carry fences on do not move.

  `commitStagedDumpChecked` then runs the same load `importDump` runs, in one transaction with the same fences and refusals, reading the rows from the stage a batch at a time. No dump carries the stage tables, and a load's drops leave them alone.
- **Vertical routes.** `vertical-host` answers `/internal/export-page`, `/internal/stage`, `/internal/restore-staged` and `/internal/stage/discard`. A host without the methods answers 501.
- **Control plane.** `transferScope` drives the copy for every carry, for adopt-onto-serving, and for the preview fork. A fork reads unstamped, so it writes nothing into its source. These still move whole, exactly as before:
  - a scope that fits in one page;
  - a source that predates the paged verbs;
  - a destination that predates them. Only this case keeps the old ceiling: the pages are merged into one dump in memory.
- `contracts` adds `scopeDumpPage` and `mergeDumpPages`; `kernel` adds `loadDropsRowsOf`.

Not yet: moving the copy out of the request into a durable job, and a copy that stays exact on a busy scope at GB scale (#2450, steps 2 and 3).
