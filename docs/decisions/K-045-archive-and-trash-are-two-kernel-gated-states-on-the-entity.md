---
id: K-45
date: 2026-10-05
layer: kernel
title: "Archive and trash are two kernel-gated states on the entity's own row, distinct from erasure and tenant deletion"
status: proposed
aliases: []
amends: ["K-41"]
tracking: ["#119"]
---

# K-45 — Archive and trash are two kernel-gated states on the entity's own row, distinct from erasure and tenant deletion

**Three acts get conflated, and each has one owner.** Subject erasure (#37, K-37) removes a person's data from everywhere the platform can reach, history included, and is not reversible. Tenant deletion and retention (#36) removes a whole tenant after a grace window. **Archive and trash** remove nothing. They hide one entity from active views and keep it, reversibly, with every event about it left as it was. This record is about the third act alone. It does not restate the other two.

**An entity opts in by declaring `archive: { permission }` and/or `trash: { permission }` in its model**, each with its own key, which the module must declare. The kernel derives everything else from that one line:

- a kernel-owned column on the entity's own table, `_substrat_archived_at` and `_substrat_trashed_at`, added by a derived migration that runs once per column, after the authored and search DDL and before the list indexes;
- the verbs `ctx.archive`, `ctx.unarchive`, `ctx.trash` and `ctx.restore`, plus `ctx.entityState`;
- a default `active` view on the reads it composes (`ctx.page`, `ctx.search`), with `view: 'archived'` on request;
- `ctx.pageTrashed` and `ctx.searchTrashed` for the bin;
- one kernel-authored event per move.

**The state is two columns, and the visible state is derived from them:** trashed if `_substrat_trashed_at` is set, else archived if `_substrat_archived_at` is set, else active. An archived entity may be trashed. `restore` clears only the trash, so it returns an entity to the state it was trashed from, archived included. Every other move out of the wrong state is `conflict` (`reason: 'invalid_transition'`), and a missing entity is `not_found`.

**The kernel checks the declared key, on the entity, in every verb and in every row of a trashed read.** It does this unlike `ctx.link`, and like `ctx.grant`. The key is declared beside the entity, and archiving or binning under some other key is the one mistake this exists to make impossible. Archive authority is not trash authority, and the archived view follows the entity's ordinary read authority. The check comes before any read of the row, so a caller without the key learns nothing about whether the entity exists.

**Module code cannot write the columns.** `ctx.sql` refuses a write naming a `_substrat_*` column: an assignment target after `SET`, an `INSERT` column list, an `ALTER TABLE`. It allows every read, including a `WHERE` inside a module's own write. The prefix is reserved whole, so a later kernel-owned column is covered without anyone listing it. A row gets into and out of the bin only through a verb that checks the key and records the move.

**Each move is a kernel-authored event**: `entity.archived`, `entity.unarchived`, `entity.trashed` or `entity.restored`, with payload `{ entity, from, to }`. Module code cannot emit these types. Who and when live on the envelope (actor, `occurredAt`, the K-34 authorization chain), not on the row: a `_by` column would be a second, pseudonymous copy of the actor that erasure would then have to reach.

**An archivable entity's list indexes are partial, one per view.** This amends K-41, whose indexes covered the whole table. Each row sits in exactly one view, so it is entered in exactly one index, and the write cost is that of the single index it replaces. An active walk then never steps over the archive, which is the part of a table that grows without bound. The view predicate is generated in one place for both the index and the query, because SQLite uses a partial index only when the query carries its terms word for word.

## What it does not do, stated

- **The kernel filters only the reads it composes.** A handler's own `SELECT … WHERE id = ?` sees an archived or binned row exactly as before. A get-by-id asks `ctx.entityState`, and a hand-written list adds the predicate itself. That is a check every operation has to remember, and the first adopter shows the cost: review found two of todo's sixteen list operations (`list-shares`, `revoke-share`) still reaching a binned list after the rest had been converted. Each check is one line, and a review is what found the misses. That class of bug is why the follow-up matters: the host refuses an entity-addressed operation on a binned entity unless the operation opts in. It is not in this record.
- **A trashed page may end early for a caller who sees little of the bin.** Its cursor is minted only from a row the caller may see, never from a refused one, because a cursor carries its row's id and sort value. One call reads at most `TRASH_SCAN_BUDGET` (2 000) rows looking for visible ones. A call that spends the budget on refused rows alone answers exactly as the end of the bin does, `[]` with no cursor. So a caller whose next visible row lies more than the budget beyond their last one never reaches it. A refusal, or a count in an error message, would instead tell them how many rows they cannot see. The fix is a sealed (authenticated, opaque) continuation, and a hosted scope holds no key to seal one with today. It is tracked as #2074.
- **No cascade.** Binning a list does not bin its items. They are hidden because every read of them goes through the list. A scope-wide read over children (todo's `search-items`) asks the parent's state itself.
- **Archived and binned entities keep their natural `key`.** A restore can never collide, and reusing a name means deleting the binned entity first.
- **No purge horizon yet.** The permanent delete is still the vertical's own delete operation. When a horizon arrives it will run that operation, so cascade rules stay the vertical's. Purging is not erasure: the events stay. Erasure reaches a binned row because the row never moved tables.
- **Entity-grant shapes are not reconciled.** A person who holds an entity-narrowed bootstrap grant (todo's owner grant, meridian's `EMPLOYEE_SELF`) does not receive a key added to that shape later. Todo's seed now mints from the same list `PERMISSIONS.md` renders, so a reseed picks the key up. A deployed vertical whose shape grows has no such path. That is a platform gap of its own, tracked separately.

## Why

**On the row, not a kernel table.** The obvious alternative, a scope-local `_substrat_entity_state(entity_type, entity_id, …)`, keeps module tables untouched but cannot be indexed beside the module's own columns. An active page would then anti-join every row it walks past, and an archive is the part of a table that grows without bound. On the row, the state can lead a partial index. It also stays where erasure (#37) already reaches, and it travels with the row through a dump, a copy and a restore with no second table to keep in step.

**Two columns, not one enum.** A single `state` column could not remember an archive while the entity sat in the bin. A restore would then either guess, or silently put a filed-away list back into the active view.

**Kernel-checked keys.** Every other read on `ctx` checks nothing. The trashed readers are the exception because what a person may see in the bin is a different question from what they may read, and the handler is not where that question should be remembered.
