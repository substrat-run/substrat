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

**Runtime DDL keeps working, around what the kernel owns.** #1811 made a module's own DDL through `ctx.sql` a supported path, and it stays one. A stateful table's guarantees live in triggers on that table, so `ctx.sql` refuses DDL that would move its rows out from under them: renaming it or its columns, dropping it or a column, creating a table, view or temp object of its name (a temp object shadows it), a trigger on it, or touching a kernel-prefixed trigger, index or view. `ATTACH` and `DETACH` are refused outright. After any DDL that passes, inside the same operation, the kernel puts back any trigger or index it derived that is missing or not as it emits it (search ones included, #2090), and fails closed if a state column is gone, so the DDL rolls back. Whether runtime module SQL should be DML only, with every schema change in a reviewed migration, is open, and not decided here.

**An authored migration is held to the same objects (#2090).** A migration runs on the scope's own handle, not through `ctx.sql`, and SQLite's ordinary create-copy-rename rebuild drops a table's triggers and indexes with it. The migrations that derived them are already journaled, so they never run again. Two rules close that. After each migration, inside its transaction, every state column the journal says was added must still be on its table. A migration that drops one rolls back, and the scope fails closed naming it: a column holds state, and cannot be derived again. After the last migration of a pass, in that same transaction, the kernel puts back the guard triggers, list indexes and search index triggers the journal says each table is owed, and rebuilds that search index, as a restore does. The search triggers matter beyond freshness: subject erasure rewrites a row's text and relies on them to take the old text out of the index. A pass with nothing pending repairs the same way, once per wake, which is what reaches a scope stripped before this rule existed, and fails closed if a journaled state column is already gone. A restore repairs inside its load, and refuses a dump whose journal owes a table it carries a state column it lacks. Each derived object is judged by its exact CREATE statement, not its name, so a same-named trigger that does nothing, or an index with the wrong columns or partial predicate, counts as missing. Only after the last, because a rebuild split over two migrations copies its rows in the second, and a guard put back in between would refuse the archived ones.

**Each move is a kernel-authored event**: `entity.archived`, `entity.unarchived`, `entity.trashed` or `entity.restored`, with payload `{ entity, from, to }`. Module code cannot emit these types. Who and when live on the envelope (actor, `occurredAt`, the K-34 authorization chain), not on the row: a `_by` column would be a second, pseudonymous copy of the actor that erasure would then have to reach.

**An archivable entity's list indexes are partial, one per view.** This amends K-41, whose indexes covered the whole table. Each row sits in exactly one view, so it is entered in exactly one index, and the write cost is that of the single index it replaces. An active walk then never steps over the archive, which is the part of a table that grows without bound. The view predicate is generated in one place for both the index and the query, because SQLite uses a partial index only when the query carries its terms word for word.

## What it does not do, stated

- **The kernel filters only the reads it composes.** A handler's own `SELECT … WHERE id = ?` sees an archived or binned row exactly as before. A get-by-id asks `ctx.entityState`, and a hand-written list adds the predicate itself. That is a check every operation has to remember, and the first adopter shows the cost: review found two of todo's sixteen list operations (`list-shares`, `revoke-share`) still reaching a binned list after the rest had been converted. Each check is one line, and a review is what found the misses. That class of bug is why the follow-up matters: the host refuses an entity-addressed operation on a binned entity unless the operation opts in. It is not in this record.
- **A trashed page may end early for a caller who sees little of the bin.** Its cursor is minted only from a row the caller may see, never from a refused one, because a cursor carries its row's id and sort value. One call reads at most `TRASH_SCAN_BUDGET` (2 000) rows looking for visible ones. A page that stops short of `limit`, whether at the end of the bin or at the budget, answers the same way either way: the visible rows it found, and no cursor. A budget stop on a sparse page therefore truncates the walk silently, and a caller whose next visible row lies more than the budget beyond their last one never reaches it. A cursor on a short page, a refusal, or a count in a message would each tell the caller that the budget ran out, which is the size of the part of the bin they cannot see. The fix is a sealed (authenticated, opaque) continuation, and a hosted scope holds no key to seal one with today. It is tracked as #2074.
- **No cascade.** Binning a list does not bin its items. They are hidden because every read of them goes through the list. A scope-wide read over children (todo's `search-items`) asks the parent's state itself.
- **Archived and binned entities keep their natural `key`.** A restore can never collide, and reusing a name means deleting the binned entity first.
- **No purge horizon yet.** The permanent delete is still the vertical's own delete operation. When a horizon arrives it will run that operation, so cascade rules stay the vertical's. Purging is not erasure: the events stay. Erasure reaches a binned row because the row never moved tables.
- **Entity-grant shapes were not reconciled.** A person who held an entity-narrowed bootstrap grant (todo's owner grant, meridian's `EMPLOYEE_SELF`) did not receive a key added to that shape later. #2071 closed that gap: a shape is now given with `grantEntityShape`, which leaves a holder marker beside the keys, and every provision and reconcile tops each holder up to the declared shape, never re-granting a key revoked from that person.

## Why

**On the row, not a kernel table.** The obvious alternative, a scope-local `_substrat_entity_state(entity_type, entity_id, …)`, keeps module tables untouched but cannot be indexed beside the module's own columns. An active page would then anti-join every row it walks past, and an archive is the part of a table that grows without bound. On the row, the state can lead a partial index. It also stays where erasure (#37) already reaches, and it travels with the row through a dump, a copy and a restore with no second table to keep in step.

**Two columns, not one enum.** A single `state` column could not remember an archive while the entity sat in the bin. A restore would then either guess, or silently put a filed-away list back into the active view.

**Kernel-checked keys.** Every other read on `ctx` checks nothing. The trashed readers are the exception because what a person may see in the bin is a different question from what they may read, and the handler is not where that question should be remembered.
