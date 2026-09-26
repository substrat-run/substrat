---
'@substrat-run/kernel': patch
'@substrat-run/contracts': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

A Durable Object's SQLite holds at most 100 columns in a table and in a result set, and the SQLite adapter now refuses the same, so a vertical's own suite sees what a hosted scope sees. A module query returning more than 100 columns, and a migration that leaves a table wider than 100 (from `CREATE TABLE` or `ADD COLUMN`), fail with the Durable Object's own messages; the migration is rolled back and the scope fails closed. Restoring or forking a dump that holds a table over the limit onto a Durable Object is refused up front, with a sentence, instead of failing partway through with a bare `SQLITE_ERROR`. Restoring the same dump on the SQLite adapter still works. `DO_SQL_LIMITS.columns` is the new limit.
