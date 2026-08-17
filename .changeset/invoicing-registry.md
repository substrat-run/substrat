---
"@substrat-run/contracts": minor
"@substrat-run/engine-invoicing": minor
---

engine-invoicing declares its entity, and `journalColumns` becomes shared.

**Why this engine mattered most.** Every demo vertical composes invoicing —
callout, handlebar, rally, shop — and none could declare an operation returning
an invoice basis without transcribing this engine's shape into the vertical. That
is the cost the notation decision (#680) exists to avoid, and it was the first
wall hit when a vertical was finally built *forward* from a concept rather than
retrofitted.

`invoicingEntities`, `underlagRow` and `underlagLine` are exported;
`UnderlagRow` and `UnderlagLine` are derived from them rather than written
beside them.

Worth recording: this engine exports **no in-scope functions at all**. Its whole
surface is `consumers` — a vertical composes it by *emitting*, not calling. So
what a vertical needs from it is not a callable API but exactly this: the entity
name and the row shape to declare a return against.

**`journalColumns` moves into contracts.** Three engines had hand-rolled the same
migration-journal parser and the copies had already drifted — none followed
`RENAME TO`, so a journal that rebuilds a table under a temporary name (which
invoicing's 0002 does: create `_new`, copy, drop, rename) would report the
pre-rebuild columns forever. One implementation now, handling `CHECK (...)`
continuations, `ADD COLUMN`, `DROP TABLE` and `RENAME TO`.
