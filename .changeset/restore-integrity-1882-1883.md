---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': patch
---

A restore, fork or preview carry now builds every `_substrat_*` table from the kernel's own schema and takes only the rows from the dump (#1883). Before, it replayed the dump's `CREATE TABLE` for these tables too, so a dump could change the schema the permission checker reads. A dump declaring `_substrat_tuples.object` as `COLLATE NOCASE` made a grant on `aiTurn:x` also answer for `aiturn:x`. The rows go in by column name:

- a column the dump lacks takes the kernel's default, so a dump taken before a column existed still restores. `_substrat_schedule_state.kind`, which is part of that table's key, is derived from the row the way the wake-time rebuild derives it;
- a column the kernel does not know is refused with `validation_failed`, and so is a `_substrat_*` table the kernel does not build. That error names every such table: the dump came from a different kind of host or a newer kernel. The refusal happens inside the load's transaction, so the target scope keeps everything it held.

A vertical's own tables still take the dump's `CREATE TABLE`.

When a restore re-points scope-level grants and a moved grant meets one the dump already holds for the destination scope, the kept row is now decided by a rule (#1882). Before, the moved row always replaced the other one, including its revocation and expiry, so a revoked or expired grant could replace a live one. Now a live grant (not revoked, not expired) beats one that is not. Otherwise the destination's grant stays, so between two live grants a restore never widens an expiry.

`repointScopeGrants` takes a fourth argument, the time expiry is judged at. A spine table is recognised by the spine guard's `_substrat` prefix without regard to case, the way SQLite resolves a table name, so `_Substrat_tuples` cannot bring its own DDL either. New kernel exports: `isSpineTable`, `assertSpineTablesBuilt`, `dumpRowsInsert`, `spineRowsInsert`, `KernelColumnsOf` and `SCHEDULE_STATE_KIND_OF_OP`.
