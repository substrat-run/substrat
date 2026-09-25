---
'@substrat-run/contracts': minor
'@substrat-run/cli': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/dashboard': patch
'@substrat-run/dashboard-web': patch
---

Promoting a version now shows the migrations it would run, each with its SQL.

`substrat push` carries every module's SQL migrations in the deploy manifest: the module, the migration's version and its SQL, in the order the host runs them. That includes the index migrations nobody writes by hand, which a module's `searchables` and `lists` declare. The kernel's new `moduleMigrations` is the one list of them in order: both hosts apply exactly it, and the push reads it from the vertical's own kernel. A vertical whose kernel predates it, and whose modules declare searchables or lists, carries no SQL rather than a short list. It is a new optional `migrations` field, so earlier CLIs and stored versions keep working. A version pushed before this field existed has no SQL to show. A set too large to carry is left out with a warning, and the push still goes through: over 2000 migrations, over 512 KiB of SQL, or a manifest that carrying them would take past 1.5 MiB. That last bound is the one that matters, because the platform stores each manifest in a single database row with a limit of about 2 MB, and JSON escaping can make SQL much larger than its own size.

A new owner-only read, `GET /verticals/:slug/versions/:id/migrations?base=<versionId>`, returns the migrations a version adds on top of another, bounded in count and size. It also lists apart any shipped migration whose SQL was edited, since a scope that already ran it will not run it again. Only the vertical's own team can read it, because migration SQL describes a schema.

In the dashboard's promote dialog, the schema section lists each new migration by id, with its SQL collapsed underneath. For a version that carries no SQL (pushed by an older CLI, or over the size a manifest carries), it says "SQL not available for this version" and asks for the acknowledgement, whether or not the registry refuses. `substrat promote` prints the permission diff and the new migrations' SQL when the registry refuses, so `--ack-permissions` and `--ack-migrations` answer something you have read. The permission diff is the dashboard's own, now in `@substrat-run/contracts`, and a change it does not itemise (an export or import, which module declares a key) is named rather than printed as no change.

A change to SQL migrations alone does not yet move the migration digest the registry compares, so the registry does not require an acknowledgement for it. The dashboard asks anyway, and says that it is the one asking.

Listing a vertical's versions no longer reads each version's whole manifest, only the two fields a version record shows, so a vertical with a long migration history lists as fast as before.
