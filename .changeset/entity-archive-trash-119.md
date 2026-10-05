---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

An entity can now be archived and moved to the trash, each under its own permission key (#119). Declare `archive: { permission }` and/or `trash: { permission }` on the entity in your model, and the kernel adds `_substrat_archived_at` / `_substrat_trashed_at` to its table through a derived migration. Existing rows come out active, and nothing needs backfilling.

- `ctx.archive`, `ctx.unarchive`, `ctx.trash` and `ctx.restore` check the declared key on the entity, refuse a move from the wrong state with `conflict` (`reason: 'invalid_transition'`), and emit `entity.archived` / `entity.unarchived` / `entity.trashed` / `entity.restored`. A restore returns an entity to the state it was trashed from, so an archived entity comes back archived.
- `ctx.page` and `ctx.search` leave archived and trashed rows out by default. Pass `view: 'archived'` to read the archive. The trash is read with `ctx.pageTrashed` / `ctx.searchTrashed`, which check the trash key on every row.
- `ctx.entityState(ref)` answers `active`, `archived`, `trashed` or `null`, for a handler's own get-by-id.
- An archivable entity's list indexes become partial, one per view, so a large archive does not slow the active list.
- `ctx.sql` now refuses a write that names a `_substrat_*` column, as it already refused one that targets a `_substrat_*` table. Reads stay allowed.
