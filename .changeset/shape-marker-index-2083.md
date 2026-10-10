---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

The entity-grant shape reconcile no longer scans every tuple in a scope on each pass (#2083). Before, a reconcile, which runs on every provision, read the whole `_substrat_tuples` table for each declared bootstrap shape even when nothing had changed, and on a large rollout it read it again for every batch.

- A new partial index, `_substrat_tuples_shape_marker` on `_substrat_tuples (object, subject) WHERE relation = 'bootstrap'`, holds only the shape markers. Both adapters create it in the scope schema, and an existing scope builds it once, the next time it wakes. The kernel exports it as `SHAPE_MARKER_INDEX_DDL`.
- Each pass reads at most ten markers per row of work its batch allows (5000 at the default batch of 500), and the next pass resumes where it stopped. A reconcile over a large scope is now a series of short transactions in which each walk reads each marker once, whether or not anyone needed a key.
- If an older deployment grants the old shape behind the point a running reconcile has reached, a holder missing a key the shape gained is topped up at the next reconcile. A holder given a key the shape retired is caught by the confirming walk. Each retirement now makes one more walk from the first marker before it records itself finished, and keeps walking until a walk takes nothing. A grant that lands behind that confirming walk keeps the retired key, the same as a grant made after the retirement finished.
- Confirming walks that take keys are capped at three per shape per reconcile, so a steady stream of new grants of a retired key cannot keep one reconcile running. At the cap, the retirement is left open without its record, and the next reconcile runs it again. `HostAdmin.reconcileEntityGrantShapes` then returns `retirementsLeftOpen`, which is present only when nonzero.
- The grantee and own-record backfills read only the shape's entity type, through the existing `(object, relation, subject)` index.
- `topUpEntityGrantShapes` takes an optional `after` cursor and returns `next` in place of `done`. `HostAdmin.reconcileEntityGrantShapes` only gains the optional `retirementsLeftOpen`.
- `@substrat-run/contract-tests` adds `shapeReconcilePlans`. An adapter uses it to have its own SQLite plan every statement a reconcile sends.
