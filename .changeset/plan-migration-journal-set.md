---
'@substrat-run/model-emit': minor
---

`planMigration` stops assuming a vertical has one journal.

A vertical composed of surfaces ships one concatenated migration list built from several
journals, and the kernel runs it in the order it is handed — it never sorts by version. So
which journal an entry goes into is the execution order, and the counter belongs to the
vertical, not to any one journal. `planMigration(entities, journal, { journals, surface })`
says that: the applied schema is read across every journal in the set (a table another
surface created is no longer diffed as missing), the next version is the highest seen
anywhere plus one (the count is not the number, and re-minting a version another surface
holds is a boot failure), and a plan that creates a table is refused unless `surface` names
one of the journals — a `parents` edge emits a `REFERENCES`, and SQLite will create a child
before its parent without complaining.

`parseJournal(raw, { surface })` reads a journal as one of a set: a shared counter puts gaps
in each of them, so position can no longer derive the counter, but a surface's journal must
still climb and never repeat. Two entries numbered `0010` in one surface is still the bad
merge it always was; `0010` in two surfaces parses.

Both options are optional and both defaults are today's behaviour, so a single-surface
vertical calls this exactly as it did and gets the same answer.
