---
'@substrat-run/model-emit': patch
---

The journal readers read SQL, not lines (#807).

`journalColumns`, `journalPrimaryKeys` and `journalUniques` split a `CREATE TABLE` body on
newlines and took the first word of each. So a journal that put two columns on one line
reported one of them — the same table, reformatted, produced a different schema. A field
report measured it: 63 entities, 38 shipped journal entries, **64 `planMigration` refusals,
none of which was the model being wrong.** Reformatting the journal to one column per line
fixed 60 of them, which is the tell: whitespace is not semantics, and history is the one
thing an append-only journal may not rewrite to satisfy a parser.

The body is now found by scanning to the paren that **matches** the opening one, and split
on **top-level commas**, with string literals and `--` / `/* */` comments skipped. That one
change carries the whole family:

- several columns on one line, and a `CREATE TABLE` written entirely on one line;
- a `) STRICT;` or `) WITHOUT ROWID;` suffix;
- a `PRIMARY KEY (` whose column list wraps over lines;
- a quoted `"order"` identifier;
- a comma inside a string literal, and a paren inside a `CHECK`.

**The two that were dangerous rather than annoying.** A `CREATE TABLE` on one line was not
refused, it was *invisible* — so `planMigration` read the table as new and emitted a second
`CREATE TABLE` for a table that already existed. A wrong migration, generated silently. And
the word UNIQUE inside a comment was read as a real constraint, which is the inverse: the
planner reporting "up to date" over a guarantee nothing enforces.

**`journalUniques` reads all three spellings.** It read only table-level `UNIQUE (b)`;
column-level `b TEXT UNIQUE` and `CREATE UNIQUE INDEX … ON t (b)` are the same constraint
by a different route, and both appear in real journals. A partial index
(`… WHERE deleted_at IS NULL`) is deliberately still not read — it constrains a subset of
the rows, so treating it as a whole-table key would claim what the database does not.

That one was not only the field report's problem. Cross-checking every journal in this repo
against a real SQLite found **13 uniqueness rules the planner could not see** — in
`workorder`, `invoicing`, `shop`, `rally`, `callout`, `meridian` and `handlebar`, all of
them spelled column-level. All 83 tables now agree with the database on columns, primary
key and uniqueness, with zero mismatches.

The reporter's four cases ship as fixtures, alongside the five the same cause turned out to
have. A successor will replace the parser outright by replaying the journal into an
in-memory SQLite and reading the schema back through `pragma_table_info` — ten minutes of
probing found five new spellings, and a regex over SQL text has no bottom.
