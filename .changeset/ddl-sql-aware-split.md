---
'@substrat-run/adapter-cloudflare': patch
---

The kernel and directory DDL now go through `splitSqlStatements` instead of a naive
`split(';')` (#164). A `;` inside a `--` or `/* */` comment in `KERNEL_DDL` truncated the
surrounding `CREATE TABLE` and every scope failed closed at DO construction with
"SQL code did not contain a statement" — while passing locally on SQLite, whose `exec`
takes the whole blob. The SQL-aware splitter already existed in the same file and was
already used for migration blobs; the DDL paths (ScopeDO's `KERNEL_DDL`, ControlPlaneDO's
`DIRECTORY_DDL` — the last two raw `.split(';')` on SQL in source) just didn't use it.

Both DDL blobs now open with a comment deliberately containing a `;`, mirroring the
contract-tests migration tripwire, so a regression to naive splitting fails every
provisioning test immediately rather than waiting for the next unlucky DDL edit.
