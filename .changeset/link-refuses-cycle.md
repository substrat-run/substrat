---
'@substrat-run/kernel': minor
---

`ctx.link(child, parent)` now refuses `parent` that is `child` itself or already lies beneath it, with `validation_failed` — the same recursive walk over live parent edges `ctx.relink` (#1864) already used, now shared by both verbs. This is a behaviour change to a shipped verb: a module that already wrote a cycle (by accident) now fails an operation that used to succeed. A store that already holds a cycle needs nothing done to it — the walk is depth-capped and terminates on an already-cyclic graph the same way `relink`'s did.
