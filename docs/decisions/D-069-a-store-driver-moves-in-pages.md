---
id: D-69
date: 2026-11-03
layer: plan
title: "A store driver moves in pages, not in one call"
status: proposed
aliases: []
amends: ["D-63", "K-49"]
tracking: ["#2854", "#2811", "#2450"]
---

# D-69 — A store driver moves in pages, not in one call

> **Proposed 2026-11-03, not ratified.** This step changes the contract a driver is written
> against, and it removes two reserved operations outright. It is written so that the choice can
> be made, and the code in this change follows it.

**A store's dump crosses the platform in pages. The reserved operations `substrat.export` and
`substrat.import` are removed, with no compatibility form, and four take their place:
`substrat.export-page`, `substrat.stage-page`, `substrat.commit-stage` and
`substrat.discard-stage`. A chain of pages is one moment of the store, the commit is the only step
that changes the object, and each registration declares the largest page its driver takes
(`dumpPageMaxBytes`).**

## Why

Until now a store's data crossed in one call each way: `substrat.export` answered with the whole
`{ tables }` and `substrat.import` took it. So a store was bounded by the smallest limit on that
path, whatever the driver:

- the store entry reads the whole request body, bounded since by `STORE_CALL_MAX_BYTES` (4 MiB),
  where the Python entry used to fail at about 6 MB
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
| `substrat.export-page` | `{ cursor, maxBytes }` | `{ tables, next, revision }` |
| `substrat.stage-page` | `{ stageId, seq, tables }` | `{ staged }`, false for a `seq` already held |
| `substrat.commit-stage` | `{ stageId }` | `{ tables }`, the count of distinct tables it wrote |
| `substrat.discard-stage` | `{ stageId }` | `{ discarded }`, whether the object held the stage |
| `substrat.selfcheck` | none | `{ operations }`, the catalog the built runtime serves (defined by [#2814](https://github.com/substrat-run/substrat/issues/2814)) |

`substrat.size`, `substrat.wipe` and `substrat.erase` stay as they were. `substrat.selfcheck` is #2814's, listed here because the canary runs it over data loaded in pages.

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
  it was one moment by being one call. The later bounded paths add backoff; this step does not.
- **The page size is the driver's to declare.** `maxBytes` bounds the serialized size of a page,
  except that a page always holds at least one table heading and one row, so `maxBytes: 1` is valid
  and means the smallest page, and one row larger than `maxBytes` rides alone. A driver never
  refuses a `maxBytes`: it may cut a smaller page. The platform asks for
  a page within what the registration declares in `dumpPageMaxBytes` (counted on the serialized
  page), which is at most `STORE_DUMP_PAGE_MAX_BYTES` (3 MiB), so a page and the call around it stay
  under `STORE_CALL_MAX_BYTES`. A driver the registry does not hold (a dev host's own) is asked for
  `STORE_DUMP_PAGE_MAX_BYTES`. Every host uses the size this gives for the driver it reaches. A row the driver could not take back in one `substrat.stage-page` is refused by
  `substrat.export-page`, naming the table, so that a backup fails when it is taken and not when it
  is restored. What a driver measures that against is the smaller of its own limit on a request and
  `STORE_CALL_MAX_BYTES` (4 MiB, [#2811](https://github.com/substrat-run/substrat/issues/2811)),
  the most a store entry takes in one call body: a row whose `stage-page` call, the page with its
  envelope around it, would be over either is refused at export. A store entry refuses a body over the
  limit with a plain 413, and the router and the platform refuse to sign one. The graph driver declares 900 000, under its 1 MB limit on a request with room for the
  envelope around a page. A TypeScript driver may declare large pages and a Python one small ones.
- **Commit is the one step that changes the object.** A stage is held aside and changes no data a
  call reads; only `substrat.size`, which counts held stages, sees it. Page `seq` 0 starts a stage and drops any other, so the old id can then neither stage
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
- **The canary proves it.** It reads its empty object as a chain of the smallest page the contract
  allows, then loads the release's own fixture (#2814) through the kernel's `writeStoreDumpPages`
  and reads it back through `readStoreDump`: the writer and the reader the platform's own paths use.
  The fixture is staged a row a page between a first and a last page that carry only its table
  headings, so the stage is several pages whatever its size, and a commit that keeps only its first
  or last page, or counts fragments, is refused. A fixture is small by intent: at most
  `STORE_CANARY_FIXTURE_MAX_ROWS` (200) rows, since each costs two calls inside a rollout's hold.
  The canary then stages a second stage, sends its first page again (which answers
  `staged: false`), discards it, runs `substrat.selfcheck` over the loaded data, erases, wipes, and
  reads once more to see nothing is left. It compares dumps as their pages merge, so a driver that
  cuts its pages differently is not refused. It calls every reserved operation, and a chain that
  never ends, or repeats a cursor, is refused.

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

## The open part

The first step moved the contract and the drivers. The second bounds what the platform holds on a
backup, a restore and a snapshot: one page of a store at a time. A backup writes each store's pages as
`store-page` entries of the backup (#2839's format), named in its manifest's `storeEntries`
(`{ binding, driver, stageId, entries, revision }`, none for an older manifest, whose stores are inline
and still restore). A restore stages every store, loads the scope, commits the stores and replays
erasures, in that order: nothing of a store changes before its commit, and once a commit was attempted
the replay runs whatever follows. A commit that fails part-way leaves some stores restored and others
not, and the answer names them; the same restore again converges, since every commit is a whole
replace. A snapshot stages the fork's stores straight from the source's.

These moves run in the request, within one budget of 300 pages or 20 s, and past it refuse (409) with
nothing changed, so a restore that reaches its commits has room to finish them and its replay. Still
open: a store past that budget cannot be backed up, restored or snapshotted (no job runs the rest), a
reaped scope's backup cannot be restored into another scope, and a pull or a tenant export still reads
a store whole into one body (question 1).

## Revisit

This record is revisited if a driver cannot offer a stable `revision` along a chain, if a page of the
declared size does not fit a store call, or when the hosts and the platform move a store without
holding its whole dump.
