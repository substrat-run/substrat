---
'@substrat-run/model-emit': minor
---

Two sharp edges in the entity vocabulary, both of which failed quietly.

**`key` is a composite, not several uniques.** `key: ['list_id', 'principal']`
means "one share per person per list" and now emits `UNIQUE (list_id, principal)`.
It used to emit one UNIQUE per field — "a list may be shared once, ever" AND "a
person may receive one share, ever" — two wrong constraints silently replacing
the composite. Stricter than intended, so it failed closed rather than open, and
nothing said so. Every declaration in the fleet was single-field, where the two
readings agree, so nothing could reveal the difference until an app needed a
composite. Closes #735.

**`z.boolean()` is refused in a stored field.** It emitted INTEGER, correctly —
and `EntityRow` then inferred `boolean`, a type SQLite can never return. Now it
refuses and names the fix, including the asymmetry that makes it subtle:
`z.boolean()` stays right for an operation's *input*, which crosses JSON. An app
can take `done: z.boolean()` and store `done: z.number()`, and both are correct.
Closes #737.

**And a hole the first change exposed.** Adding a `key` to an entity whose table
already exists is a schema change the planner could not see — it read columns,
not constraints — so it reported "up to date" over a missing uniqueness
guarantee, which is how a duplicate gets in. `journalUniques` reads constraints
back out of a journal, and `planMigration` refuses a key it cannot apply, because
SQLite cannot add one without rebuilding the table.

That reader follows `RENAME COLUMN`, since SQLite rewrites the constraint along
with the column — verified against a real database. And a key whose column is
renamed by the *same plan* is translated before comparison, or the planner would
refuse the very change that fixes it.
