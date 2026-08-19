---
'@substrat-run/model-emit': minor
---

The journal readers replay the journal instead of parsing it.

`journalColumns`, `journalUniques` and `journalPrimaryKeys` now run the journal into a
throwaway in-memory SQLite and read the schema back through `PRAGMA table_info`,
`index_list` and `index_info`. Same three signatures, same answers, no parser.

**Why, rather than another patch.** The previous change fixed seven ways a regex over SQL
text read a journal wrongly — several columns on a line, a one-line `CREATE TABLE`, a
`) STRICT;` suffix, a wrapped `PRIMARY KEY (` list, a quoted identifier, a comma in a
literal, the word UNIQUE in a comment. Finding those took ten minutes of probing, which is
the argument: a parser over a language it does not implement has no bottom, and each fix
is a patch against the next spelling. SQLite already implements SQLite.

**What it removes.** `journal.ts` goes from 388 lines to 82. The `RENAME TO` /
`RENAME COLUMN` / `DROP TABLE` replay loops — written out three times, once per reader, and
each a re-implementation of what the database does for free — are gone, along with the
constraint-rewriting-on-rename special case that had to be verified against a real database
to be written at all. A table rebuild (`create _new`, copy, drop, rename) is followed
because SQLite follows it.

**What it adds.**

- A journal whose schema statements do not apply now **throws**, naming the statement.
  The old readers answered anyway, which is how a broken migration passes a parity test.
  It caught an invalid fixture in this package's own test suite on the first run: a partial
  index over a column the table did not have.
- `readSchema` and `statements` are exported for a tool that wants the schema itself.
- Only schema statements are replayed. A journal's `INSERT`s change no schema, and skipping
  them is what lets a vertical's journal be read alone when it hands data to an engine whose
  tables live in a different journal (decision 28's extraction handoff). Foreign keys stay
  off, so a `REFERENCES` across journals is created rather than refused.

**Node 22.5+**, via the `node:sqlite` builtin — no new dependency. Not a new restriction in
practice: this package is a devDependency in all 13 of its dependents, no `src/` file
imports it, and the builder runs its gates as shell commands in a container. Declared as an
`engines` floor.

All 83 tests pass, 77 of them unchanged from before the rewrite — which is the equivalence
proof, since they are the same assertions against an entirely different implementation.
