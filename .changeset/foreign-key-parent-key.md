---
'@substrat-run/model-emit': patch
---

A foreign key points at the parent's own key, not an assumed `id`.

`columnsOf` emitted `REFERENCES <table>(id)`. That was correct only while every
entity was keyed by `id` — which `primaryKey` (#804, shipped in 0.4.0) stopped
being true. A parent edge to a side table now emits a reference to a column that
does not exist:

```sql
CREATE TABLE vertical_workorder_ext (
  workorder_id TEXT PRIMARY KEY NOT NULL,   -- no `id` anywhere
  note TEXT
);
CREATE TABLE vertical_ext_line (
  id TEXT PRIMARY KEY NOT NULL,
  workorder_ext_id TEXT NOT NULL REFERENCES vertical_workorder_ext(id),   -- wrong
  text TEXT NOT NULL
);
```

**And nothing catches it until data moves.** SQLite does not validate a foreign
key target at `CREATE TABLE`, so the DDL parses, the model compiles, and a
parity check comparing column sets passes. Then every valid child row is
rejected at INSERT with `foreign key mismatch` — not the dangling ones, all of
them.

The reference now names the parent's actual key column. A single column pointed
at a **composite**-keyed parent is refused at emit — SQL needs a table-level
`FOREIGN KEY (a, b) REFERENCES t(x, y)` for that, and the model has no notation
saying which local column maps to which, so inventing one would be guessing.

Found by running the emitted DDL against a real database rather than asserting
on the string, which is worth doing here generally: the same run confirmed that
a composite primary key's `NOT NULL` is load-bearing, because SQLite does not
imply it — a non-INTEGER `PRIMARY KEY` accepts NULLs, composite included.
