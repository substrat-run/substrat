---
'@substrat-run/contracts': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/contract-tests': patch
'@substrat-run/cli': patch
---

Every site that replays a scope dump judges it first

A dump names its own tables and columns and carries its own schema text, and all
three reach SQL as text — a bind parameter can stand in for a value but never for an
identifier, and never for a `CREATE TABLE`. `substrat scope pull`/`restore` were
hardened for this already; the three server-side replay paths were not, and one of
them is the hosted scope restore.

Two problems, and the second is the larger. Names were interpolated behind double
quotes, which a crafted name closes. And executing a table's schema ran *every*
statement the text contained — `db.exec` on SQLite and `SqlStorage.exec` on a Durable
Object both do — so anything appended to an honest `CREATE TABLE` ran too, with
entirely plain identifiers that no name check would have caught.

A dump is now refused unless its names are plain SQL identifiers, each table is
listed once (case-folded, as SQLite resolves them), and each table's schema is
exactly one `CREATE TABLE` for the name it is listed under. The checks live in
`@substrat-run/contracts` beside the schema they judge, so the rule is stated once
rather than three times and fixed in one of them.

Restoring a dump whose schema carries a second statement now fails instead of
silently loading part of it. No dump `exportScope` produces looks like that.
