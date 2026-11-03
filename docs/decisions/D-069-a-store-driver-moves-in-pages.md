---
id: D-69
date: 2026-11-03
layer: plan
title: "A store driver moves in pages, not in one call"
status: proposed
aliases: []
amends: ["D-63", "K-49"]
tracking: ["#2811", "#2814", "#2450"]
---

# D-69 — A store driver moves in pages, not in one call

> **Proposed 2026-11-03, not ratified.** This step changes the contract a driver is written
> against, and it removes two reserved operations outright. It is written so that the choice can
> be made, and the code in this change follows it.

**A store's dump crosses the platform in pages. The reserved operations `substrat.export` and
`substrat.import` are removed, with no compatibility form, and five take their place:
`substrat.selfcheck`, `substrat.export-page`, `substrat.stage-page`, `substrat.commit-stage` and
`substrat.discard-stage`. A chain of pages is one moment of the store, the commit is the only step
that changes the object, and each registration declares the largest page its driver takes
(`dumpPageMaxBytes`).**

## Why

Until now a store's data crossed in one call each way: `substrat.export` answered with the whole
`{ tables }` and `substrat.import` took it. So a store was bounded by the smallest limit on that
path, whatever the driver:

- the store entry reads the whole request body, bounded since by `STORE_CALL_MAX_BYTES` (5 000 000
  bytes), where the Python entry used to fail at about 5 to 6 MB
  ([#2811](https://github.com/substrat-run/substrat/issues/2811));
- the control plane holds the string, the parsed JSON and the schema-checked copy of the answer in
  one isolate;
- a backup adds a serialized and an encoded copy and writes one R2 object, and a restore reads it
  back the same way;
- the store's own limit on a request, 1 MB by default for the graph driver.

[#2450](https://github.com/substrat-run/substrat/issues/2450) solved this for a scope's own tables
with pages of table fragments. Stores never got it. This record gives stores the same shape, and
writes it for any driver rather than for one language.

## The operations

| Operation | Input | Answer |
| --- | --- | --- |
| `substrat.selfcheck` | none | `{}`, once the driver's runtime has been built ([#2814](https://github.com/substrat-run/substrat/issues/2814)) |
| `substrat.export-page` | `{ cursor, maxBytes }` | `{ tables, next, revision }` |
| `substrat.stage-page` | `{ stageId, seq, tables }` | `{ staged }`, false for a `seq` already held |
| `substrat.commit-stage` | `{ stageId }` | `{ tables }`, the count of distinct tables it wrote |
| `substrat.discard-stage` | `{ stageId }` | `{ discarded }`, whether the object held the stage |

`substrat.size`, `substrat.wipe` and `substrat.erase` stay as they were.

- **Fragments.** `tables` holds fragments in the shape #2450 gives a scope's pages: a table's rows
  may spread over pages, each fragment names its table again, and every table appears at least
  once across a chain, empty or not, so its schema travels. A driver may answer an empty last page.
  Concatenating a table's fragments in page order gives the table.
- **A chain is one moment, and the contract says what, not how.** `cursor` is opaque: `null`
  starts, each answer's `next` continues, and `next: null` ends the chain. `revision` is opaque
  too. While it stays the same along a chain, the pages are one read. When it changes, the reader
  starts again, and after three chains that moved it refuses with `conflict` rather than answer a
  dump of no one moment. How a driver keeps the promise is its own: it may pin a revision, refuse
  writes during the read, or read a snapshot. Any change to what the dump holds changes the
  revision, the reserved writes included: a commit, a wipe, and an erase that erased something. The
  same state reads the same revision across chains. A revision that is a hash of the content is
  allowed, so a commit of identical content need not move it. A chain whose `next` is the cursor it
  was asked with, or that passes 100 000 pages, is refused as a driver that does not move or does
  not end.
- **A multi-page read can fail where the single call could not.** Under steady writes a read of
  several pages can answer 409 after its three attempts, which the old single call never did, since
  it was one moment by being one call. The bounded paths below back off between chains; the dev
  hosts' whole read does not.
- **The page size is the driver's to declare.** `maxBytes` bounds the serialized size of a page,
  except that a page always holds at least one table heading and one row, so `maxBytes: 1` is valid
  and means the smallest page, and one row larger than `maxBytes` rides alone. A driver never
  refuses a `maxBytes`: it may cut a smaller page. The platform asks for
  a page within what the registration declares in `dumpPageMaxBytes` (counted on the serialized
  page), and never above a page of a scope's own dump (4 MiB). Every host uses the declared size of
  the driver it reaches. A row the driver could not take back in one `substrat.stage-page` is refused by
  `substrat.export-page`, naming the table, so that a backup fails when it is taken and not when it
  is restored. What a driver measures that against is the smaller of its own limit on a request and
  `STORE_CALL_MAX_BYTES` (5 000 000 bytes, [#2811](https://github.com/substrat-run/substrat/issues/2811)),
  the most a store entry takes in one call body: a row whose `stage-page` call, the page with its
  envelope around it, would be over either is refused at export. A store entry refuses a body over the
  limit with 413, and the platform refuses to send one. The graph driver declares 900 000, under its 1 MB limit on a request with room for the
  envelope around a page. A TypeScript driver may declare large pages and a Python one small ones.
- **Commit is the one step that changes the object.** A stage is held aside and changes nothing a
  call can see. Page `seq` 0 starts a stage and drops any other, so the old id can then neither stage
  nor commit. Pages arrive in order. A `seq` already held answers `staged: false` and changes
  nothing, so a lost answer can be retried, and a gap is refused. `substrat.commit-stage` replaces
  the whole object atomically, and a stage that is abandoned or fails before its commit leaves the
  object as it was.
  - A wipe drops every stage. An erase drops every stage too, since a stage may hold the subject: a
    restore racing an erase then fails at its commit, cleanly. `substrat.size` counts stages.
  - A stage unused for longer than `STORE_STAGE_MAX_AGE_MS` (seven and a half hours, the age the
    scope's own staged load holds) is dropped no later than the next call to the object, so a driver
    needs no timer.
  - A commit asked again for the stage last committed answers the same count and changes nothing.
    This makes a commit retry safe. Only that stage answers: an older one is refused, and so is any
    after a wipe, which ends the memory of the last commit (a new page 0 or an erase does not). A
    stage id is not used again: `substrat.stage-page` naming the stage last committed is refused. A
    stage the object does not hold is refused with status 409, code `stage_refused`. None of this
    makes a failed write atomic: a lost commit answer can leave the object replaced while the writer
    reports failure, and the writer's retry, or the next restore, finishes it.
  - The writer treats `staged: false` as an error, since each page goes once under a fresh id, and
    compares the commit's count with the distinct tables it sent. A failed discard does not hide the
    failure that led to it, since the driver drops an abandoned stage itself. An empty dump is one
    empty page, so an empty stage replaces the object as any other does.
- **The whole-object operations go.** If a release is approved before this lands, that driver's next
  release adds these operations. No driver release is approved, so nothing depends on
  `substrat.export` and `substrat.import`. They are removed, not kept beside the new operations, and
  a driver that answers them gains nothing.
- **The canary proves it.** It runs `selfcheck`, reads a chain of the smallest page the contract
  allows, stages the dump of its empty object as fragments over three pages (sending the first again,
  which answers `staged: false`), commits, reads it back, stages and discards a second stage, erases,
  wipes, and reads once more to see nothing is left. It compares dumps as their pages merge and counts
  tables once each, so a driver that cuts its pages differently is not refused. It calls every
  reserved operation, and a chain that never ends, or repeats a cursor, is refused.

## Any driver, one reference

None of this is specific to the graph driver or to Python. The runner suite (`scopeStoreRunnerChecks`)
asserts the contract on any driver: a chain that ends, one revision and the same dump at any page
size, many rows cut into pages within `maxBytes` with none lost between them, a revision that moves
on a commit and a wipe, a commit that replaces rather than merges and keeps every page of a stage, a
page sent twice held once, a stage that changes nothing before its commit, a new stage that drops the
old one, a discard that really drops the stage, a wipe and an erase that drop every stage, and a
commit asked again that answers the same count. The suite's fixture gives it a way to write distinct
rows (`writeRow`). Each of those has a deliberately broken driver that must fail exactly its checks.
`counterScopeStoreRunner`, the TypeScript reference driver, passes with several pages, so the contract
is shown on a driver written in TypeScript as well as on one in Python.

## The platform holds a page

The contract moved first. This part makes the paths on the hosted control plane bounded for any
driver, and it is proposed with the rest of this record: the maintainer may change its form. No path
below holds more than one page of a store at a time, and what a request or a job hands on is cursors
and counts, never a row. The dev hosts' `exportScopeStores` and `importScopeStores` stay whole: they
run beside one small local store and serve no isolate limit.

**One stepper, not `transferStep`.** Read a page, write it, next; a revision that moved starts again
under a new id; only a commit changes the object. That is the shape of #2450, but `transferStep`
and `advanceCopyJob` assume more than a store has: a client that names scopes, a capture to catch
up on, a `_substrat_meta` to fold, a move's lease in the ledger. Stubbing all that out would cost more
than the stepper in `store-move.ts` over two ends (`read`, `write`), so a store has its own and shares
`withDeadline` and the retry with the vertical client.

**Every store call has a deadline and a retry.** `PAGE_CALL_DEADLINE_MS` (60 s) over the call and its
answer, and three tries on a transient fault, an unreachable script included. A refusal is never
retried, the 413 of `STORE_CALL_MAX_BYTES` and a 409 among them. A `staged: false` on a retry is the
call's own lost answer, so it counts as staged. A commit asked again answers the same count; a
`stage_refused` there means another writer came between, and it surfaces as the failure it is. A
commit that outlasts its three tries may still land, so it is reported as unknown (below).

**A chain that moves backs off.** A revision that moved, or a read or a page answered 409 (a driver
that refuses a read during writes, a stage that an erase or a wipe dropped), starts the chain again
after 1, 2, 4 and 8 s, in a job by the alarm and not by sleeping. After five chains it refuses with
409 and the object as it was. The count is kept across a job's steps, since those five chains are
what the promise is about: resetting it per step would let a job restart until its deadline.

**A step resumed from a record older than what it sent** (a step that died before its answer was
stored) depends on what it reads. A snapshot reads a live source, and a driver may cut a page
otherwise this time, so a `staged: false` with no retry to explain it starts the chain over,
uncounted. A restore reads immutable objects, each verified, and the same stored page cut at the same
size is the same pages, so a `staged: false` means the stage already holds exactly this, and it goes
on. A fault costs a restore one step, not the store. A backup writes a page again in place.

**Snapshot** reads each page from the source and stages it on the fork, then commits once every store
is staged. It runs in its request, whose directory steps are not a job's to finish, so a store past
the request's budget refuses (409). A fork that fails is new, so nothing is lost by dropping it: its
stages are discarded, its stores wiped, and its row set to expire, for the sweep to reap, which is why a
fork with stores binds its version before they are copied. A request that dies outright leaves a row
with no expiry, as it did before. A bind asking for `snapshot: true` over the budget says what unblocks
it: take a backup, which runs as a job, then bind without the snapshot.

**Backup.** A store's pages are objects of their own under the backup's key
(`<capturedAt>/stores/<moveId>/<seq>.json`), the scope's own tables, sealed as they always were, are
`<capturedAt>/scope-<attempt>.json`, and the index is written last at `<capturedAt>.json`, the key a
backup has always had: binding, driver, revision, page count, and each page's key, byte size and
SHA-256. The object at that key is the backup. Until it lands, a read or a listing sees nothing, so a
backup whose index is missing is not a backup. A backup of a scope with no store the platform reaches
keeps the one-object form. A backup holds at most 20 000 pages of one store (`STORE_BACKUP_MAX_PAGES`,
about 18 GB at the graph driver's 900 000 bytes), and past that it refuses (413). It refuses up front
when `substrat.size` says twice that, one call per store, an estimate since it counts stages and storage
rather than pages. A job's six hours need about 0.93 pages a second to reach the cap. An index entry is
about 235 bytes, and the index is read on every step of a restore: 20 000 pages is 4.7 MB of JSON and
about 7 MB of heap to parse, measured, where the chain's own limit of 100 000 would be 23 MB and about
34 MB, beside a page and the schema's copy, in a 128 MB isolate.

Two backups in one millisecond share an address and no object: each has its own scope object and its
own chains, the last index written is the backup, and one giving up takes only its own, the index only
if it names that scope object. The parts of an index overwritten that way stay until retention.

**A reap stops a backup or a restore.** Both reap routes cancel the scope's store jobs before they
unroute it, waiting for a step running now: a backup still moving is dropped with what it wrote, a
finished one stays as any held copy does, and a restore's stages go. A restore a call is finishing
right now refuses the reap, to retry. Each job step also reads the scope, and a backup reads it again
right before the index, so a reap by the sweep, which does not cancel, stops a job within a step. A
restore into a scope archived while it ran refuses before the load and before the commits. A restore
run in one request, into a scope already archived when it began, has no record for a reap to find. This
record left open that its commit could land between a reap's wipe and the status flip; D-70 closes that
at the object, which refuses a commit once a deletion has fenced it.

**Retention** walks scope by scope with a delimiter, so it never lists the pages of a backup it keeps,
and deletes as it goes, in batches of 1000, the index first. A pass spends at most 200 listings and
deletes (`SCOPE_PRUNE_PASS_CALLS`). Out of budget, it leaves a cursor at the last scope it finished, and
the next pass starts after it, so every scope is reached however many stand ahead of it, and a scope
with more to delete than a pass can spend loses some on each. A part no index ever named goes by the
same `capturedAt`. Without a retention window, what a backup that failed left behind is deleted when it
fails, and what a crash left stays until someone sets one.

**An old backup stays restorable.** `stores` inline is read as it always was, through the backup's
route and as a body, since backups are data people hold. A paged backup's dump, read back, names its
pages in `storePages` and carries no row. The body route refuses it with 422, naming the backup's
route, and never reads a key from a request. `scopeDump` knows the field so that it is not stripped
into a restore that leaves the stores as they were.

**Restore** is `POST …/scopes/<destination>/backups/restore` with `{ capturedAt, sourceScopeId }`, the
source defaulting to the destination. A reap's copy is the only recoverable form of a reaped scope
(`control-plane.md` §4.4), so the backup is read under the source, reaped or not, and it lands in the
destination, under which its job is keyed. The replay reads the source's marks too. It keeps the order
that a person can see: `refuseUndeclaredDumpStores`, the host's load, the stores, the erasure
replay, the deployment's load. It stages first. Every page is verified as it is read and staged, and
the host's load and the commits run only when every store is staged. So a missing or a mangled page
refuses with nothing changed anywhere, which today's order could not do once the host had loaded. Each
stored page is cut again at the size the driver declares now, one stored page at a time, so a backup
survives its driver lowering `dumpPageMaxBytes`, unless one row is itself past what the driver now takes,
which rides alone and is refused; a job fixes that size in its spec, so its cuts stay the same across
its steps. A reaped destination refuses on both restore routes, and on this one again before the load
and before the commits. The CLI and the dashboard refuse a file of a paged backup, naming what to do,
rather than send it without `storePages` and leave the stores as they were.

**A commit that fails is not the end of the restore's duty.** Commits run before the replay, and a store
replaced by an old backup holds subjects erased since. So once a commit was attempted, the replay runs
even on failure, since a commit whose answer was lost may have landed, and the answer is the refusal
with `committedStores`, `commitUnknown` for a binding whose commit cannot be told (its answers were lost,
or its retry was refused after a first answer was lost, since that first try may have landed), and
`incomplete: true`. `storeErasureIncomplete: true` says separately that an erasure was not replayed.
`substrat scope restore` prints all of them.
The deployment's load has not run, so the router serves what it served. With several stores this is
partial: those committed stay replaced. Running the restore again finishes it.

**A store may bring data forward after its commit, and may not be ready.** A driver restoring a dump
of an older schema version commits at that version and migrates on its later calls, answering 503 until it
is done, or 500 if a step fails on those rows. So a good count from `substrat.commit-stage` does not
say the store works. After the last commit the platform asks each committed store `substrat.selfcheck`,
with the call's own retry and deadline, and waits for a 503 with a backoff (a `Retry-After` honoured)
for up to `STORE_READY_WAIT_MS` (30 s) across all the stores. This runs after the commits and before the
erasure replay and the deployment's load, since the replay calls `substrat.erase` on each store and the
load makes the scope serve from them: both would meet the same 503 or 500 instead of the cause. A store
that stays 503 past the wait, or answers a 5xx, is named in `storesNotReady`, and the answer is
`incomplete: true` with `committedStores`, a 502 on both routes, the replay run and the deployment's load
not run. So a driver may fail a restore this way after its commit. A store still busy may come ready; one
whose step failed does not, and a caller cannot see why, since a 5xx body is stripped on its way out and
the driver logs the step's message. The way out is to wipe that store and restore another backup. A
backup or a snapshot whose source answers 503 is a store migrating: in a request it answers 503 saying
the store is busy, and a job treats it as a transient fault that does not count toward the faults a job
fails after, waiting with a growing backoff (at most 60 s, a `Retry-After` honoured) until its deadline.

**A deployment that refuses the load after the commits** is the one case that running it again does
not finish. The deployment's load comes last, and it judges the dump inside `/internal/restore`: a role
set it cannot define, a journal that is not coherent, a dump this release cannot take. No endpoint asks
that without loading, and nothing read beforehand can stand in for it: what the live scope's
`appliedMigrations` says is not what a load will refuse. So the stores stay replaced while the scope's
own tables stay as they were, and the answer names them (`committedStores`, `incomplete: true`). The way
out is a deployment that can take the dump, or a restore of a backup it can. A check without side effects
on the deployment is what would close this, ahead of the commits.

**Job, not request.** A request moves up to 300 pages or 20 s, a page costing a read and a write of
its 1000 subrequests. A backup or a restore past that goes to a job in `ScopeCopyJobDO`, under an id of
its own kind, with no new Durable Object class to migrate. Bindings that cannot be built in a step are a
counted fault, and the job's deadline still holds. A step stops at 300 pages as well, since an alarm
has the same subrequests.

The route answers 202 with the job's `capturedAt` and its progress. A backup is asked about by naming
that (`POST …/backups?capturedAt=`): its progress, its failure or the backup itself, as often as asked, so
an answer lost on the way is asked for again. A POST naming none is answered 202 for the job while one
runs, under that job's `capturedAt`, and otherwise takes a new backup: one that finished earlier is never
answered as if taken now. What a step moved past its stored record is given up when it faults or fails. A backup's job writes the index itself, so it lands whether
or not anyone is still asking. A restore's job stops at everything staged, and the next call loads and
commits, as a preview's copy job does; a stage that aged out or that an erase dropped by then refuses
cleanly, and asking again starts over. A call for one backup is never told of a job for another as if
it were its own. The reap routes do not answer 202: a store too large for the request refuses, naming
`POST …/backups`, and the scope stays. There is no scheduled scope backup: `backupDirectoryIfDue` copies
the directory, which holds no store.

**Masking and erasure are unchanged.** A masked export carries no store. A page object is as unsealed
as a dump's inline store was and an erasure deletes neither, so the guarantee stays where it was: the
replay after the commit erases every subject tombstoned at the destination or the source.

### What the maintainer was asked

1. **The backup format.** Yes: as above, a store's data leaves `stores` for its own objects and the
   index, written last, is what makes a backup. Without it a large store cannot be backed up.
2. **Tenant export and full pull.** They refuse rather than stream, for now, and that has a price to
   state plainly: **past the limit, no path exports such a store through the API.** A backup holds it and
   restores it into its scope, and cannot be downloaded through the API, since `GET …/backups/:capturedAt`
   names the pages and carries no row. A pull answers one JSON body, and a store's rows go through
   `c.json` in one isolate, so past `STORE_PULL_MAX_BYTES` (32 MB, spent across the stores of the answer,
   a tenant export's across its scopes) it answers 413, having read no more than fits. A row counts as its
   bytes and 64 more, since 32 MB of tiny rows parse and serialize to about 170 MB of heap, measured, and
   about 40 MB with the charge. A driver whose pages are so small that it would take more reads than one
   request can make, chains started over included, gets the same 413, under its own cause. `substrat scope pull` prints that sentence. The kept-copy export carries no store at
   all. **Open for the maintainer: links to a backup's objects, or a stream.** Links hand out what a
   staff route has so far opened and audited. Until that is decided, the portability such a tenant is
   owed rests on staff reading the bucket by hand, with no tool and no audit for it yet. This record
   does not close that gap.
3. **Scope and stores as one moment.** No, and this does not make them so. A scope is read, then each
   store, and each store's chain is one moment of its own; in a job, hours can lie between. Making them
   one needs a fence across two objects that do not know each other, and nothing in the contract offers
   one. It was so before, in the time one request took. The replay covers erasure across that gap. A
   vertical that keeps references between its tables and its store must tolerate them being apart.
4. **`ddl` on a table.** Opaque schema text, required and non-empty. The platform never parses a store's
   `ddl`: it only carries it back. A driver not built on SQL writes whatever lets it rebuild the table.
5. **A store written to more often than a chain lasts cannot be backed up.** A driver's revision moves on
   any change, and a moved revision starts the chain again, so such a store refuses after its five chains
   however long they back off. The backoff helps a store with quiet moments and not one without. **Open
   for the maintainer:** the contract already allows a driver to pin a revision along a chain or to refuse
   writes during a read, and a driver that does either has no such limit. Should the platform ask a driver
   to, or quiesce the scope for a backup?

### What is not bounded

- **A scope's own tables in a backup and a restore.** They keep their form, whole, as this step was
  scoped: `vertical.exportScope`, the seal and one object. A scope past the isolate fails there, as before.
- **A snapshot, past the request's budget.** Its memory is bounded and its reach is not: it refuses.
- **A store past `STORE_BACKUP_MAX_PAGES`.** It refuses, as a limit on the index and not on its data.
- **The erasure replay** still runs in one request, one call per subject per store, as it did.
- **A reap's own backup, and a tenant reap's,** run in the request. Past it they refuse.
- **A restore that fails partway through several stores** leaves those committed replaced.

## Revisit

This record is revisited if a driver cannot offer a stable `revision` along a chain, if a page of the
declared size does not fit a store call, or when a pull answers by links or a stream instead of
refusing.
