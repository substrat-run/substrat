---
'@substrat-run/model-emit': minor
---

`planMigration` — the migration journal, derived. Nobody writes the version
number.

`emitTables` could only ever say "here is the current shape as one CREATE",
which is right before an app has data and wrong the moment it does: re-emitting
would rewrite a shipped entry. That made it a parity check rather than a source,
and it is why a real app with production data could not adopt generation.

The model states the current shape; the journal states what has been applied.
`planMigration` reconstructs the second from the journal itself, diffs against
the first, and appends **exactly one** entry with a derived, position-checked
counter. Declaring a version declares a fact the diff already knows — and
hand-numbering has failed in practice: a production journal ships two entries
numbered 0010 because two people numbered by hand in two branches. Two branches
generating `0003` now collide in `journal.json`, which is the correct signal on
an append-only ordered list; resolution is mechanical.

**It refuses rather than guesses.** A dropped table, a dropped column (a diff
cannot tell a rename from a drop-plus-add, and guessing wrong loses the data),
and a required column with no default added to a table that may already hold
rows — SQLite cannot add one, and pretending otherwise breaks on real data. Each
refusal names the decision it is deferring to a human.

Also exports `columnsOf` and `uniqueConstraints`, shared with `emitTables` so a
column added by `ALTER TABLE` renders exactly as a fresh `CREATE TABLE` would.
That sharing caught a live defect: building a new table from a one-entity subset
dropped every `REFERENCES` clause pointing outside it.
