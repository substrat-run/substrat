---
'@substrat-run/cli': patch
---

`scope pull` and `scope restore` refuse a backup whose table or column names are not
plain SQL identifiers. A dump names its own tables, and a name is interpolated into
SQL because a bind parameter cannot stand in for an identifier — so a crafted
`.dump.json` or `.sqlite` could close the quoting and run statements of its own
against the local file. The names are now checked before any of them reaches SQL,
and the error says which one was refused.

A dump's schema text is held to the same line: `scope pull` compiles a table's DDL
as a single statement rather than executing everything the text contains, so
`CREATE TABLE x (…); ATTACH DATABASE …;` creates the table and nothing else, and a
DDL that does not create the table it is declared for is refused.
