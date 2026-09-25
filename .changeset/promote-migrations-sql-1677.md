---
'@substrat-run/contracts': minor
'@substrat-run/cli': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/dashboard': patch
'@substrat-run/dashboard-web': patch
---

Promoting a version now shows the migrations it would run, each with its SQL.

`substrat push` carries every module's SQL migrations in the deploy manifest: the module, the migration's version and its SQL, in the order the host runs them. It is a new optional `migrations` field, so earlier CLIs and stored versions keep working. A version pushed before this field existed has no SQL to show. A set too large to carry (over 2000 migrations or 2 MiB of SQL) is left out with a warning, and the push still goes through.

A new owner-only read, `GET /verticals/:slug/versions/:id/migrations?base=<versionId>`, returns the migrations a version adds on top of another, bounded in count and size. It also lists apart any shipped migration whose SQL was edited, since a scope that already ran it will not run it again. Only the vertical's own team can read it, because migration SQL describes a schema.

In the dashboard's promote dialog, the schema section lists each new migration by id, with its SQL collapsed underneath. For a version pushed before migrations were carried, it says "SQL not available for this version" and still asks for the acknowledgement. `substrat promote` prints the permission diff and the new migrations' SQL when the registry refuses, so `--ack-permissions` and `--ack-migrations` answer something you have read.

A change to SQL migrations alone does not yet move the migration digest the registry compares, so the registry does not require an acknowledgement for it. The dashboard asks anyway, and says that it is the one asking.
