---
'@substrat-run/contracts': patch
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': patch
---

A scope restore, fork or preview carry now builds every `_substrat_*` table from the kernel's own schema and takes only the rows from the dump (#1883). Before, it replayed the dump's `CREATE TABLE` for these tables too, so a dump could change the schema the permission checker reads. A dump declaring `_substrat_tuples.object` as `COLLATE NOCASE` made a grant on `aiTurn:x` also answer for `aiturn:x`. The rows go in by column name:

- a column the dump lacks takes the kernel's default, so a dump taken before a column existed still restores. `_substrat_schedule_state.kind`, which is part of that table's key, is derived from the row the way the wake-time rebuild derives it;
- a column the kernel does not know, from a newer kernel's dump, is kept: it is added as a plain untyped column (no type, collation, constraint or default), with its values. It cannot change how the columns the permission checker reads compare. A later kernel that adds the column for real finds it already there;
- a restore into a node scope skips the spine tables a Durable Object's scope builds and a node scope keeps in its directory or not at all (`_substrat_roles`, `_substrat_tenant_tuples`, `_substrat_entitlements`, `_substrat_identity_links`, `_substrat_connection_keys`, `_substrat_meta`, `_substrat_migration_bookmarks`), so a DO's dump loads there;
- any other `_substrat_*` table the kernel does not build is refused with `validation_failed`. The error names every such table and says the dump came from a different kind of host or a newer kernel. The refusal happens inside the load's transaction, so the target scope keeps everything it held.

A vertical's own tables still take the dump's `CREATE TABLE`. A table named in the search index's namespace, in any case, is skipped like the index itself. Building the spine from the kernel covers the scope restore only: a directory restore still replays its dump's DDL. Every dump check, the directory restore's and `substrat scope restore`'s included, now also refuses a dump that lists a column twice in one table (case-folded), as it already refused a table listed twice.

When a restore re-points scope-level grants and a moved grant meets one the dump already holds for the destination scope, the kept row is now decided by a rule (#1882). Before, the moved row always replaced the other one, including its revocation and expiry, so a revoked or expired grant could replace a live one. Now the higher-ranked grant is kept: live (not revoked, not expired) above revoked above expired, since a revocation is evidence and an expiry is not. On a tie the destination's grant stays. When two live grants meet, the one kept takes the earlier of their two expiries (no expiry counts as the latest), so a restore never lengthens a grant's life.

`repointScopeGrants` takes a fourth argument, the time expiry is judged at. A spine table is recognised by the spine guard's `_substrat` prefix without regard to case, the way SQLite resolves a table name, so `_Substrat_tuples` cannot bring its own DDL either. New kernel exports: `isSpineTable`, `assertSpineTablesBuilt`, `dumpRowsInsert`, `spineColumnAdditions`, `spineRowsInsert`, `KernelColumnsOf` and `SCHEDULE_STATE_KIND_OF_OP`. New `@substrat-run/adapter-sqlite` export: `DO_SCOPE_ONLY_SPINE_TABLES`.
