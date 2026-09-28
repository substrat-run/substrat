---
'@substrat-run/kernel': minor
---

`ctx.link(child, parent)` now refuses `parent` that is `child` itself or already lies beneath it, with `validation_failed` — the same recursive walk over live parent edges `ctx.relink` (#1864) already used, now shared by both verbs. This is a behaviour change to a shipped verb: a module that already wrote a cycle now fails an operation that used to succeed. A store that already holds a cycle needs nothing done to it — the walk never revisits a ref (`UNION`, not `UNION ALL`), so it terminates on an already-cyclic graph instead of looping, the same way `relink`'s did; its cost grows with the size of `parent`'s ancestor set, not with a depth cap (that's the permission checker's own walk, capped at 4 — a different mechanism).
