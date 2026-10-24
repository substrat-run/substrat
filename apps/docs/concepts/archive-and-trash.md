---
description: "Archive and trash: two reversible, separately permissioned ways to hide one entity, declared on the entity, served by derived operations, and kept apart from subject erasure."
---

# Archive and trash

People mean three different things by "delete", and the platform keeps them apart:

| The act | What it removes | Reversible | Where it lives |
|---|---|---|---|
| **Archive** | nothing — the entity leaves the active views and stays readable | yes | this page |
| **Trash** | nothing yet — the entity is hidden from everyone but whoever may restore it | yes, until it is purged | this page |
| **Subject erasure** | one person's data, everywhere the platform reaches, history included | no | [Events & audit](./events.md) |

Deleting a whole tenant is a fourth thing, handled by the control plane. Archive and trash are
about **one entity**, and neither touches its history: every event about it stays as it was.

## Declaring it

An entity opts in on its own declaration in `spec/model.ts`, each act under its **own**
permission key:

```ts
list: {
  table: 'todo_lists',
  fields: z.object({ id: z.string(), owner_id: z.string(), name: z.string(), created_at: z.string() }),
  parents: ['owner'],
  archive: { permission: 'list:archive' },
  trash: { permission: 'list:trash', purgeAfterDays: 30 },
},
```

That one declaration is all you write. The platform derives the rest:

- two kernel-owned columns on the entity's own table, `_substrat_archived_at` and
  `_substrat_trashed_at`, added by a derived migration. Module code cannot write them:
  `ctx.sql` refuses a write naming a `_substrat_*` column;
- the moves, `ctx.archive`, `ctx.unarchive`, `ctx.trash` and `ctx.restore`, plus
  `ctx.entityState(ref)`. Each checks the key the entity declares, on that entity;
- one kernel-authored event per move: `entity.archived`, `entity.unarchived`,
  `entity.trashed`, `entity.restored`;
- the **active view** on every read the kernel composes (`ctx.page`, `ctx.search`), with
  `view: 'archived'` on request, and `ctx.pageTrashed` / `ctx.searchTrashed` for the bin.

Archive authority is not trash authority. Someone who may file a list away cannot bin it
under that key, and the reverse. That is the mistake the two keys exist to make impossible.

## The state, and the moves

An entity is in exactly one state, read off the two columns:

| State | When | Who sees it |
|---|---|---|
| `trashed` | `_substrat_trashed_at` is set | only someone holding the trash key, in the bin |
| `archived` | else `_substrat_archived_at` is set | anyone who may read it, in the archived view |
| `active` | otherwise | anyone who may read it |

An archived entity may be trashed. `restore` clears only the trash, so the entity goes back to
where it was binned from, archived included. A move from the wrong state is a `conflict`, and
a missing entity is `not_found`.

## The operations are derived

Each move is the check and one kernel call, so you do not write it. Declare the operation with
[`derive`](./model.md#derived) and the platform writes the handler:

```ts
import { entityStateOutput } from '@substrat-run/contracts';

'todo/archive-list': {
  summary: 'Archive a list',
  derive: 'archive',
  permission: { key: 'list:archive', entity: 'list', idFrom: 'listId' },
  input: z.object({ listId: z.string() }),
  output: entityStateOutput,
  http: { method: 'POST', path: '/lists/{listId}/archive' },
},

'todo/restore-list': {
  summary: 'Restore a list from the trash',
  derive: 'restore',
  permission: { key: 'list:trash', entity: 'list', idFrom: 'listId' },
  trashed: 'admits',
  input: z.object({ listId: z.string() }),
  output: entityStateOutput,
  http: { method: 'POST', path: '/lists/{listId}/restore' },
},

'todo/trashed-lists': {
  summary: 'The lists in your trash',
  derive: 'trashed',
  narrows: { reason: 'Returns only binned lists the caller may restore', checks: ['list:trash'] },
  output: todoEntities.list.fields,
  paged: { over: { entity: 'list', sortable: ['created_at', 'name'] } },
  http: { method: 'GET', path: '/lists/trash' },
},
```

| `derive` | Checked under | Answers |
|---|---|---|
| `archive`, `unarchive` | the entity's archive key, on the row | `entityStateOutput` — `{ id, state }` |
| `trash`, `restore` | the entity's trash key, on the row | `entityStateOutput` |
| `trashed` | the trash key, on **every row** of the bin | a page of the entity's rows |
| `list` | its own key | a page of the active rows, or the archived ones when the input carries `view: 'archived'` |

A move declares no `emits`: the kernel announces it. Archive and unarchive declare the same
shape, so a hand-written one is named as both when `defineOperations` refuses it; `derive` is
what says which move it is. The bin declares no leading check, because the walk checks the trash
key on each row: a person whose key is narrowed to the lists they binned sees those lists and
no others.

## Nothing reaches a binned entity by accident

The host refuses any operation addressed to a trashed entity (`permission: { entity, idFrom }`)
with `not_found`, before its handler runs, unless the operation says it reaches the bin:

- `trashed: 'admits'` — a restore, or a read of the bin;
- `trashed: 'purges'` — the entity's one permanent delete.

The declared key is checked first, so a caller without it gets the same `permission_denied`
for a binned, an active or a missing entity, and cannot probe the bin. An archived entity is
never refused: archiving is not deleting. `ctx.link` refuses a trashed parent as if it did not
exist.

An operation whose check is `resolved` in the handler is one the host cannot read a target off.
It asks `ctx.entityState(ref)` itself, and `pnpm lint:model` warns about each one on a
trashable entity, so the gap is visible at build time.

## The purge horizon

`trash: { permission, purgeAfterDays }` derives a schedule that runs the entity's
`trashed: 'purges'` operation on everything binned longer than that. Wire it with
`schedules: purgeSchedulesOf(ops, entities)`. It runs as the module's system principal, whose
purge key is withheld from every other call, and it stops with the module's kill switch like
any other schedule.

Purging is your delete, run on a timer. It is not erasure: the events about the entity stay.

A pass purges at most 50 entities, oldest first, and the next pass carries on from where it
stopped. If your purge operation calls `ctx.requestPlatform`, the scope's cap on pending requests
(32) bounds a pass too. A purge that meets a full queue after the pass has already got past its
first entity rolls back whole and is not counted as a failure: the pass stops there, and the next
pass, on the next sweep, starts at that entity. If the queue is still full when it gets there, the
refusal is a failure like any other. A purge the full queue refuses at the *first* entity of a pass
is an ordinary failure, and so is every refusal after it in that pass; those entities stay in the
bin and are retried on the next lap. The pass walks on, so a purge that needs no request still
commits behind a refused one, and an entity whose purge can never fit (it enqueues more requests
than the scope will ever have room for) cannot hold up the others.

Nothing drains a scope's requests between its schedules within one sweep, so every purge horizon
on the scope shares the same 32 slots, in your module and in any other module the scope runs. A
horizon with a large backlog can fill the queue before the next one runs, and that next horizon's
first entity is not failed for it. When purges run earlier in the same sweep enqueued requests,
the pass tries nothing: its run is reported as deferred (counted as skipped, never as fired), and
the schedule stays due, so it runs again on the next sweep rather than waiting its whole cadence.
It waits only while the horizons ahead of it keep committing requests, which means they are
emptying their own bins. On the first sweep where none of them enqueues anything, its first entity
runs like any other: it purges if the queue has room, and fails if its purge can never fit.

Only purges count toward that. Requests from your ordinary schedules, which run before the purge
horizons, and from any other traffic are not the sweep's purges, and a queue they filled fails the
first entity as before. An ordinary schedule may enqueue on every sweep, and if those requests
counted, a horizon behind it would wait indefinitely. The next sweep normally finds the queue drained:
the platform sweep drains the scope again straight after its schedules, and a hosted vertical's
scope sweeper asks the platform to drain once its pass ends. A queue still full on the next sweep
refuses the horizon ahead as well, so that horizon enqueues nothing, and the first entity behind it
fails as before. Have a purge enqueue at most one request per entity.

The purge operation is also the entity's permanent delete, so by default a person holding its
key can empty the bin at any time. If the purge operation must only ever run on what has sat in
the bin for the whole horizon, declare `trash: { permission, purgeAfterDays, purgeEarly: false }`.
The host then refuses the purge operation with `not_found`, for every caller, on an entity that
is not in the bin or was binned less than `purgeAfterDays` ago (and on one that does not exist,
with the same answer). It checks the declared key first, so the refusal reveals nothing. Your
handler needs no date comparison of its own.

The floor holds the purge operation, not the bin. An operation declared `trashed: 'admits'`
whose handler deletes the row still removes a binned entity at any time, and so does a
handler's own `ctx.sql`. That is how you give people a delete-for-good alongside a floored
purge; if nothing may remove a binned entity early, declare no such operation.

## What it does not do

- **Only the reads the kernel composes are filtered.** A handler's own
  `SELECT … WHERE id = ?` sees an archived or binned row. Prefer `ctx.page` and derived
  operations, and ask `ctx.entityState` where you write your own read.
- **No cascade.** Binning a list does not bin its items. They are hidden because every read
  of them goes through the list.
- **A binned entity keeps its natural key.** Reusing a name means deleting the binned entity
  first.

`demos/todo` is the reference: its lists are archivable and trashable, and its `spec/model.ts`
declares every operation on this page.
