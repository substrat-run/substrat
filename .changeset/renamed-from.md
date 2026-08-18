---
'@substrat-run/contracts': minor
'@substrat-run/model-emit': minor
---

`renamedFrom` — the one declaration a migration diff cannot derive.

`planMigration` refused a dropped column, because a diff sees a field gone and a
field arrived and cannot tell a rename from a drop-plus-add. Guessing wrong drops
the column and everything in it, so refusing was right — and it also left a
rename unrepresentable, which is the next thing any app with data hits.

An entity may now declare `renamedFrom: { current: previous }`, and the planner
emits `ALTER TABLE … RENAME COLUMN` instead of refusing. Verified against real
SQLite: the rows survive and a `UNIQUE` constraint follows the column.

It is the ONLY declaration in the journal that is not derived — including the
version number — and it is **deletable after use**: once the rename has shipped,
the old name is gone from the journal and the entry is a gravestone the model may
remove. Both halves are tested, along with the control proving the same change
is still refused without it.

The declaration's KEY is checked by the planner rather than by the compiler:
TypeScript does not apply excess-property checking when satisfying a generic
constraint, so an unknown key widens instead of erroring. Written the obvious way
the constraint reads like a working check and enforces nothing, so it is not
claimed — `planMigration` refuses it instead, with a message naming the rule.

**Fixes a live defect in `journalColumns`**, which handled `ADD COLUMN`,
`DROP TABLE` and `RENAME TO` but not `RENAME COLUMN` — so a renamed column read
as its old name forever, and a planner deriving from that journal would have
re-emitted the same rename on every run.

Closes #734.
