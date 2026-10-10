---
'@substrat-run/kernel': minor
'@substrat-run/contract-tests': minor
---

The entity-grant shape backfill now reads a bounded window per pass, as the marker walks already do (#2154). The backfill is the first reconcile of a shape that declares a `holder`. Its writes were bounded before, but each pass read every candidate row of the shape's entity type, or the holder's whole table, and started over from the beginning. On a large scope that cost passes × rows.

- Each pass reads at most ten rows per row of work, out of the same read budget the walks use. The rows come in index order: the type's tuples on `(object, relation, subject)` for a `'self'` or `'grantee'` holder, and the holder table in `idColumn` order for a table holder.
- The next pass seeks past the last row read. `ShapeCursor` gains an optional `row` that carries this position. A cursor without `row`, from an older deployment or after a rollback, starts the backfill over, which is safe because a holder already marked is no longer a candidate.
- The run-once `shape-backfilled` record is written only once a read reaches the end of the range. Before, it was written as soon as a pass marked fewer holders than its budget allowed.
- A table holder is bounded only when its `idColumn` leads an index; a primary key does. On a scope where it doesn't, the backfill's first pass writes a structured `shape-backfill-unbounded` warn line naming the table and column. The backfill still runs; it just isn't bounded.
- Evidence that lands behind the backfill's position while it runs is not marked. This is the same accepted gap as evidence landing after the backfill ends.
- `@substrat-run/kernel` exports `SHAPE_MARKER_READS_PER_ROW`. `shapeReconcilePlans` in `@substrat-run/contract-tests` now plans and counts the backfill for all three holder kinds. It also takes an optional engine read count, so a Durable Object can assert the per-pass bound in the rows it actually read.
