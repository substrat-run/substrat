---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

An authored migration that rebuilds a table (#2090) no longer strips what the kernel derived onto it: the archive/trash guard, the list indexes, the search index. SQLite's create-copy-rename rebuild drops a table's triggers and indexes, and the migrations that derived them never run again. After the last migration of a pass, the kernel now puts back the guard triggers, the derived list indexes and the search index triggers, and rebuilds that search index. Without the search triggers, text rewritten or deleted afterwards, by subject erasure among others, stayed searchable. A migration that drops `_substrat_archived_at` or `_substrat_trashed_at` rolls back instead, and the scope fails closed naming that migration. A scope stripped before this release is repaired on its next wake or `migrateScope`, and a derived object is judged by its definition, not its name. A restore whose dump lacks a state column its own journal says it has is refused, and the load rolls back.
