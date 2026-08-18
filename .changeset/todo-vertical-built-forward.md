---
'@substrat-run/model-emit': patch
---

`emitTables` emits parent tables before child tables.

Sorting by name alone put `todo_items` — which `REFERENCES todo_lists` — first.
SQLite tolerates a forward reference; a stricter engine does not, and "it
happened to work" is not a property to ship. Parents now precede children,
alphabetical within a tier, so the output stays deterministic and diffable. A
parent cycle is reported rather than silently truncated.

Found by emitting a real journal for a vertical whose entities form a chain —
the existing fixtures' tables happened to sort into a working order.
