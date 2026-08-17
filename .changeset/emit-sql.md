---
"@substrat-run/contracts": minor
---

`emitTables` — DDL derived from the entity registry, the first deterministic emitter.

Every adopter currently hand-writes its `CREATE TABLE` and keeps a test holding it
to the registry. That test exists *because* the duplication does; deriving the DDL
is what deletes both.

It reproduces the hand-written journals exactly. `emit-parity.test.ts` in Callout
and Handlebar compares the emitted schema against the checked-in migrations by
COLUMN SET — not by string, since whitespace, column order and `REFERENCES`
placement are incidental — and every entity matches.

- an `id` becomes `TEXT PRIMARY KEY **NOT NULL**`
- `key` becomes `UNIQUE`
- `parents` becomes a real `REFERENCES` clause when the entity declares the
  matching `<parent>_id` column, and is skipped when it does not
- an enum becomes `CHECK (col IN (…))`; a boolean becomes `INTEGER`, since SQLite
  has none

**It is stricter than the hand-written schemas, and the parity test asserts it.**
In SQLite a non-INTEGER primary key does NOT imply `NOT NULL`, so `id TEXT PRIMARY
KEY` accepts a NULL id — a hole every `vertical_*` table in this repo has. The
emitter cannot produce it.

**It reads the TypeScript, never `model.json`.** `z.toJSONSchema` drops `.refine()`
and `.brand()`, so an emitter reading the JSON would emit a schema weaker than the
model declares.

**It refuses rather than guesses.** A Zod shape it cannot map throws, naming the
field. #695's 18 broken events came from an emitter defaulting instead — applied
uniformly, silently, eighteen times.

Not included: the derived journal (versioning, released-entry freezing,
expand/contract). This emits a schema, not a migration history — that is the
bottom-right cell of the plan's lifecycle table and it is unbuilt everywhere.
