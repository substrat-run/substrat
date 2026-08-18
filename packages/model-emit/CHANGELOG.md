# @substrat-run/model-emit

## 0.2.0

### Minor Changes

- f869541: `planMigration` — the migration journal, derived. Nobody writes the version
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

- 46b1cac: `renamedFrom` — the one declaration a migration diff cannot derive.

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

- 4e174cc: Two sharp edges in the entity vocabulary, both of which failed quietly.

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
  `z.boolean()` stays right for an operation's _input_, which crosses JSON. An app
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
  renamed by the _same plan_ is translated before comparison, or the planner would
  refuse the very change that fixes it.

### Patch Changes

- f869541: `emitTables` emits parent tables before child tables.

  Sorting by name alone put `todo_items` — which `REFERENCES todo_lists` — first.
  SQLite tolerates a forward reference; a stricter engine does not, and "it
  happened to work" is not a property to ship. Parents now precede children,
  alphabetical within a tier, so the output stays deterministic and diffable. A
  parent cycle is reported rather than silently truncated.

  Found by emitting a real journal for a vertical whose entities form a chain —
  the existing fixtures' tables happened to sort into a working order.

- Updated dependencies [f869541]
- Updated dependencies [19fb697]
- Updated dependencies [f869541]
- Updated dependencies [717600e]
- Updated dependencies [46b1cac]
- Updated dependencies [9208b4e]
  - @substrat-run/contracts@0.72.0

## 0.1.0

### Minor Changes

- ce44df8: Build-time tooling moves out of `contracts` into `@substrat-run/model-emit`.

  `emitTables` and `journalColumns` are things you **run to build**, not vocabulary a
  vertical imports at runtime. Leaving them in `contracts` put an emitter in the
  runtime dependency graph of every vertical that declares a model — tree-shaking
  usually saves you, and "usually" is the wrong guarantee for a package described as
  _the shared vocabulary_.

  **Apache-2.0**, like the rest of the build surface. LICENSING.md's line is whether
  a package is the substrate you run to serve (AGPL — kernel, adapters,
  control-plane-api, engines) or something you build with (Apache — contracts,
  templates, the CLI). A generator is the second, and it never touches a network.

  **`jsonColumn` stays in `contracts`.** It looks like tooling because only the
  emitter reads it, but you _write_ it in your model — it is vocabulary, and the
  boundary is what you author, not who consumes it.

  The two exports belong together: the emitter's claim is "what this emits is what
  the database ends up with", and the reader is how that gets checked. They are held
  to each other rather than each to a hand-written string.

  Thirteen test files across six engines and five demos pick up a devDependency.

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0
