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

**Runtime DDL keeps working, around what the kernel owns.** #1811 made a module's own DDL through `ctx.sql` a supported path, and it stays one. A stateful table's guarantees live in triggers on that table, so `ctx.sql` refuses DDL that would move its rows out from under them: renaming it or its columns, dropping it or a column, creating a table, view or temp object of its name (a temp object shadows it), a trigger on it, or touching a kernel-prefixed trigger, index or view. `ATTACH` and `DETACH` are refused outright. After any DDL that passes, the kernel checks every stateful table still carries its columns, triggers and list indexes, and fails closed if not, so the DDL rolls back. Whether runtime module SQL should be DML only, with every schema change in a reviewed migration, is open, and not decided here.

**Each move is a kernel-authored event**: `entity.archived`, `entity.unarchived`, `entity.trashed` or `entity.restored`, with payload `{ entity, from, to }`. Module code cannot emit these types. Who and when live on the envelope (actor, `occurredAt`, the K-34 authorization chain), not on the row: a `_by` column would be a second, pseudonymous copy of the actor that erasure would then have to reach.

**The host refuses an operation on a trashed entity it did not declare it reaches** (#119 PR 2). An operation whose leading check is `{ entity, idFrom }` over an entity that declares `trash` is refused on a trashed one inside its transaction, before its guards and its handler, for every caller and every door. The module hands the host `operationTargets: operationTargetsOf(ops)`, and registration refuses a module that declares a trashable entity and leaves it out, so the refusal is not something a module can lose by forgetting a line. An operation opts in with `trashed: 'admits'` (a restore, a read of the bin) or `trashed: 'purges'` (the entity's one permanent delete), and the compiler allows either only where there is something to opt out of.

**The order of that refusal is the security property.** On a trashed entity the host checks the operation's declared key first, as the handler's first line would: a caller without it gets the same `permission_denied`, naming the same key, that an active or a missing entity gives, so the bin cannot be probed. Only a caller who holds the key learns the entity is gone, as `not_found`. An active entity is never checked by the host; the handler checks it as before, so no pass is recorded twice. An archived entity is never refused: archive is not a delete.

**`ctx.link` refuses a trashed parent, and `ctx.relink` a trashed `to`, with `not_found`.** Nothing new hangs off a binned entity. An archived parent is allowed: whether something may be added to a filed-away entity is the vertical's rule. `relink`'s `from` may be trashed, since moving a child out from under a binned parent is how it is rescued.

**A purge horizon is declared on the entity and runs the vertical's own delete.** `trash: { permission, purgeAfterDays }` derives, through `purgeSchedulesOf(ops, entities)`, one schedule running the operation that declares `trashed: 'purges'` for that entity, hourly (`PURGE_CADENCE_MINUTES`), holding that operation's key. Being a schedule is what gives it everything a schedule already has:
- the module's system principal, its grant seated at provisioning and rendered in `PERMISSIONS.md`, and the K-34 authorization chain on every event it emits;
- the kill switch (#1666), which is the per-scope way to stop it;
- the lifecycle hold;
- the exclusion of every copy that is not primary, previews included (#2005);
- a sweeper on a pushed deploy (#1902).

The sweep reads at most `PURGE_BATCH` (50) due entities per pass, oldest trash first, through a derived partial index, and invokes the operation once per entity, each its own transaction. Inside that transaction the host re-checks that the entity is still trashed, at or before the cutoff, so a restore that lands between selection and purge wins (`conflict`, reason `purge_not_due`). An entity restored or already gone is skipped. Any other throw is reported on the pass and leaves that entity in the bin, to be retried. A crash loses nothing that committed, and the next pass selects what is left. A full batch leaves the schedule due, so a backlog drains on the following sweep passes.

**The purge grant runs only the purge.** The system principal's grant is scope-wide, because the sweep does not know in advance which entities it will delete. A key the system principal holds only for purge schedules is therefore withheld from its checks everywhere except the purge sweep's own call of the purge operation: another operation checking the same key, a job step, or a host-level call made with the module's system authority is refused. A dedicated purge key per entity would make that visible in the role table too, at the cost of a new permission key per adopter. It is the alternative, not taken here.

**Purging is not erasure, and it is not a retention policy.** The row goes the way the vertical's delete has always removed it, and every event about the entity stays (#37 reaches those). A tenant that must keep its bin, such as under a legal hold, has the module's kill switch today, which also stops the module's other schedules. A per-scope "keep my trash" belongs to tenant retention (#36), not here.

**An archivable entity's list indexes are partial, one per view.** This amends K-41, whose indexes covered the whole table. Each row sits in exactly one view, so it is entered in exactly one index, and the write cost is that of the single index it replaces. An active walk then never steps over the archive, which is the part of a table that grows without bound. The view predicate is generated in one place for both the index and the query, because SQLite uses a partial index only when the query carries its terms word for word.

## What it does not do, stated

- **The kernel filters only the reads it composes, and the host refuses only the operations it can see.** A handler's own `SELECT … WHERE id = ?` sees an archived or binned row exactly as before. The host refusal above closes that for every operation addressed by `idFrom`, which is where the first adopter's review found the misses (`list-shares`, `revoke-share`). It cannot close it for an operation whose entity the host cannot read off its input: a check `resolved` in the handler, a `refFrom` check, a `narrows` walk. Those keep their own `ctx.entityState` check, and `lint:model` warns about each `resolved` one on a trashable entity, so a new vertical sees the gap at build time. In todo they are `set-item-done` and `delete-item` (through the item's list), `revoke-share` (through the share's list) and `search-items` (a `narrows` walk that asks each hit's list state).
- **A trashed page may end early for a caller who sees little of the bin.** Its cursor is minted only from a row the caller may see, never from a refused one, because a cursor carries its row's id and sort value. One call reads at most `TRASH_SCAN_BUDGET` (2 000) rows looking for visible ones. A page that stops short of `limit`, whether at the end of the bin or at the budget, answers the same way either way: the visible rows it found, and no cursor. A budget stop on a sparse page therefore truncates the walk silently, and a caller whose next visible row lies more than the budget beyond their last one never reaches it. A cursor on a short page, a refusal, or a count in a message would each tell the caller that the budget ran out, which is the size of the part of the bin they cannot see. The fix is a sealed (authenticated, opaque) continuation, and a hosted scope holds no key to seal one with today. It is tracked as #2074.
- **No cascade.** Binning a list does not bin its items. They are hidden because every read of them goes through the list. A scope-wide read over children (todo's `search-items`) asks the parent's state itself.
- **Archived and binned entities keep their natural `key`.** A restore can never collide, and reusing a name means deleting the binned entity first.
- **Entity-grant shapes are not reconciled.** A person who holds an entity-narrowed bootstrap grant (todo's owner grant, meridian's `EMPLOYEE_SELF`) does not receive a key added to that shape later. Todo's seed now mints from the same list `PERMISSIONS.md` renders, so a reseed picks the key up. A deployed vertical whose shape grows has no such path. That is a platform gap of its own, tracked separately.

## Why

**On the row, not a kernel table.** The obvious alternative, a scope-local `_substrat_entity_state(entity_type, entity_id, …)`, keeps module tables untouched but cannot be indexed beside the module's own columns. An active page would then anti-join every row it walks past, and an archive is the part of a table that grows without bound. On the row, the state can lead a partial index. It also stays where erasure (#37) already reaches, and it travels with the row through a dump, a copy and a restore with no second table to keep in step.

**Two columns, not one enum.** A single `state` column could not remember an archive while the entity sat in the bin. A restore would then either guess, or silently put a filed-away list back into the active view.

**Kernel-checked keys.** Every other read on `ctx` checks nothing. The trashed readers are the exception because what a person may see in the bin is a different question from what they may read, and the handler is not where that question should be remembered.
