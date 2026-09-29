---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/cli': patch
'@substrat-run/contract-tests': patch
---

A directory restore now builds the directory's `_substrat_*` tables from the running code's own schema and takes only the rows from the dump (#1898), as a scope restore has since #1883. Before, it replayed the dump's `CREATE TABLE` for these tables too, and the directory holds `_substrat_tenant_tuples` and `_substrat_roles`, which every tenant-level permission check reads. A dump declaring their columns `COLLATE NOCASE` made a tenant-level grant or role match without case. The rules are the scope restore's: a column the dump lacks takes the default; a column this code does not know is kept as a plain untyped column, lowercased, with its values; a column named for SQLite's rowid is refused; a `_substrat_*` table this code does not build is refused, naming every such table. The schema pass runs inside the restore's transaction, before any row goes in, so a refused dump leaves the directory as it was. A dump taken before the schedule switch's record existed gets that record backfilled from its own admin log inside the same transaction, so a backfill that fails rolls the restore back instead of committing it without the record.

A table a restore replays may no longer declare a foreign key to a `_substrat*` table (case-folded, whatever the quoting, with or without comments between `REFERENCES` and the name). With foreign keys enforced, the kernel's own writes to that spine table (a revoke, a restore's re-point) could otherwise fail on the vertical's rows. Every dump check refuses it: the scope and directory restores on both adapters, and `substrat scope pull` / `restore`. The same rule holds a module's own SQL: `ctx.sql` refuses such a statement as a `forbidden` `spine_write`, and so does every migration a scope applies, which then fails the scope closed with the migration recorded as the failure.

The SQL scanner the spine guard reads statements with, and the spine prefix, now live in `@substrat-run/contracts` (`tokenizeSql`, `SPINE_PREFIX`, `namesSpineTable`, `referencedTables`), so the guard, the dump checks and the CLI's foreign-key ordering of a dump read `REFERENCES` one way. The CLI's own regex missed a target behind a comment. New kernel export: `assertNoSpineReference`, plus `SYSTEM_SWITCHES_TABLE`. `pnpm lint:spine-ddl` holds the directory's additive spine columns to the same nullable-with-no-DEFAULT rule as a scope's.
