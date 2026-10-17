---
status: built
layer: plan
description: How the platform collects attachment bytes no row names, and the runbook for turning it on.
---

# The orphan-attachment sweep, and how to turn it on

An attachment write puts its bytes in the tenant's attachment store before its row. A crash
between the two, a transport failure whose commit is unknown, or a PITR rewind past a row can
leave an object no row names. Nothing reads it, but it costs storage and the storage meter counts
it. The sweep deletes such objects (#2314).

It has two halves:

- **The pass** (`sweepOrphanAttachments` on a host, `packages/kernel/src/attachment-sweep.ts`).
  It runs one scope at a time inside the deployment that holds the scope. It guards a committed
  row's bytes four ways: a tombstone before every delete, a seven-day age floor, a 35-day restore
  fence, and a refusal from any copy of the scope that is not the live one.
  `apps/docs/concepts/attachments.md` describes them.
- **The driver** (this page). It is a phase of the control plane's scheduled pass,
  `orphanAttachments` in `runPlatformSweep`. It chooses the scopes, asks the right deployment, and
  records what happened.

## What the driver decides, and where

For each scope in its window, the control plane does all of the following before it asks any
deployment (`sweepScopeAttachments`, `packages/control-plane-api/src/attachment-sweep.ts`):

1. **Reads its own directory.** The scope must be on record, active, primary, bound to a vertical,
   and under an active tenant.
2. **Reads the whole copy ledger itself.** Every entry for the scope must be `done`, the kernel's
   allowlist (`SETTLED_COPY_STATES`). A pending, eligible, kept or retained copy in another
   script may hold rows the serving copy lacks, so it refuses the pass. A deployment without a
   directory cannot do this read. That is why the request carries `copiesSettled: true`, and only
   the control plane sets it.
3. **Routes to the serving script only.** The scope's serving script if it has one, otherwise its
   bound version's script: the same routing decision the router makes. There is no fallback to a
   channel or another version. The control plane never asks its own host, because that host's
   scope namespace holds none of the scope's rows and would judge every object an orphan.

Only then does it call `POST /internal/attachment-sweep` on that script. The body must state
`dryRun`, carry `copiesSettled: true`, and name `expectedVersionId`: the version the directory
says runs there (the serving pointer's, else the bound version). It takes no instant: the host
judges age and the fence against its own clock.

The scope's copy checks that version against the one its script is deployed as
(`SUBSTRAT_VERSION_ID`, which every pushed script carries) before it judges anything:
- a script deployed as another version refuses the pass in either mode. That covers a stale
  script, a dispatch mixup, and a promote that lands mid-pass. Each is counted as `refused` and
  writes no admin-log row;
- a script that carries no version identity refuses a destructive pass and lets a dry run
  through;
- a host the platform does not route to (a self-host) is asked nothing.

A destructive pass also writes its own line to the deployment's log (`orphan-attachment-sweep`)
with the scope, the counts and the deleted keys, whatever the control plane records.

The scope's own storage holds the dry-run-first rule too (#2350), so it holds whoever asks for a
pass. See "The scope's licence" below.

The deployment answers with the pass's report. Every guard the pass has also applies on the
deployment's side.

## Per pass

- The window holds at most `ORPHAN_ATTACHMENT_SWEEP_BATCH` scopes (default 25) out of the active
  primary scopes. It starts at a random point in the id order and wraps around, the rule the
  provision reconcile uses. A scope that fails on every pass cannot hold a slot forever, and
  every scope is reached over enough passes. With the 15-minute cron that is 2,400 scope visits a
  day.
- A scope whose migration failed in this pass is skipped.
- Outcomes are counted in `report.orphanAttachments`:
  - `refused`: the directory or the deployment said no, for example an unsettled copy or a
    suspended tenant.
  - `unsupported`: the deployment predates the route (501, or a route miss) and needs a redeploy.
  - `awaitingDryRun`: a delete-mode scope given a dry run instead, because the admin log held no
    recent dry-run row for it, or because the scope refused the destructive pass for want of its
    own licence (`orphan_sweep_unlicensed`). In that second case the dry run runs in the same visit.
  - `noStore`: the deployment holds no attachment store for the tenant, and the scope holds no
    attachment row (`bucket: 'none'`): a vertical that keeps no files. A scope that does hold an
    attachment row but has no store has a missing store binding. That is not `noStore`: it fails,
    and lands in `errors`.

  None of the three is an error, so the failure digest does not repeat them every pass. Anything
  else that fails is an `attachment-sweep` error.
- The tail logs the phase's counts whenever it found or deleted an orphan, or a scope was refused
  or unsupported. `noStore` alone does not print it, since file-less verticals answer that on every
  visit.
- If the admin-log row cannot be written after a pass deleted anything, the pass logs a line with
  the scope, the counts and every deleted key, and records an `attachment-sweep` error. The bytes
  are gone by then, and that line is the record of which ones.

## The admin log

A pass that found an orphan, or deleted one, writes one `sweepOrphanAttachments` row. The row
holds the scope, the actor `01JZ00000000000000000000SW` (the sweep), whether it was a dry run,
the counts, and every key deleted or, in a dry run, every key a pass would delete. Read the rows
with the console's admin log, or `GET /admin-log?action=sweepOrphanAttachments`.

## `delete` needs a dry run first, per scope

In `delete` mode, a scope is swept for real only when the admin log holds a **dry-run** row for
it from the last seven days (`ORPHAN_SWEEP_DRY_RUN_WINDOW_MS`). Any other scope gets a dry run
instead, which writes that row if it finds anything. The report counts those scopes as
`awaitingDryRun`.

So the environment value alone deletes nothing. Every delete is preceded by a recorded report of
that scope's orphans, and the report is at most a week old. A scope whose dry run found nothing
has nothing to delete, and it is dry-run again on its next visit.

### The scope's licence (#2350)

The admin-log row is the control plane's rule, and it holds only for the passes the control plane
starts. The deployment's route takes `dryRun: false` from any caller that holds the platform's
secret. So the scope's own storage holds the same rule, and a deployment pushed with it refuses a
destructive pass that no dry run of its own licensed.

- **What is recorded.** A dry run that finds orphans writes the ids it listed (the ids behind its
  report's keys, at most `ORPHAN_SWEEP_LICENCE_CAP`, 1,000) into the spine table
  `_substrat_attachment_sweep_licence`, each stamped with the host's clock at that run. It writes
  only when that set differs from the one held, or the one held is older than half the window, so
  a scope whose orphans stay the same moves no write revision on every pass (a carry and a
  kept-copy release are fenced on it). A dry run that lists nothing clears the record. A dry run
  the restore fence holds is not one of those: it stops before it lists anything, and leaves the
  record as it was.
- **The window.** The record is in force for `ORPHAN_SWEEP_DRY_RUN_WINDOW_MS` (seven days, the
  same window as the admin-log row), judged against the host's clock. A stamp more than a minute
  ahead of the clock (a clock that went back) is not in force.
- **The refusal.** A destructive pass with no record in force is refused with `conflict`, reason
  `orphan_sweep_unlicensed`, before anything is listed, so it is refused even when there is
  nothing to condemn.
- **What it deletes.** Only ids the record lists. The condemnation intersects each batch with the
  record inside its own transaction, and every guard of the pass still applies to each listed id.
  So an object that crossed the age floor after the dry run is not deleted until a dry run lists
  it.
- **Consumption.** Each id a destructive pass deletes leaves the record. A backlog larger than one
  pass's limit therefore drains over consecutive passes after one dry run, as long as the dry run
  listed it (the dry run lists up to its own `limit`). The same pass also takes out every licensed
  id whose object its listing no longer holds, gone some other way, even when it deletes nothing.
  So a record that lists nothing deletable does not keep the scope licensed until it expires. Once
  the record is empty the next destructive pass is refused, and the phase dry-runs the scope again.
  A pass whose deletes fail, or that a fence stops after the condemnation, changes nothing in the
  record. A pass that cannot bring the record up to date afterwards (the scope suspended or carried
  away mid-pass) still returns its report with every deleted key, marked `consumeFailed`, and logs
  a line with the scope and the count. The deployment's own log line for the pass carries the
  marker too. The phase counts it in `consumeFailed`, and its admin-log row names the keys as usual.
  The rows it could not remove name ids that are gone, so they license nothing a later pass could
  delete, and the next pass that brings the record up to date takes them out.
- **Restores, carries, forks.** A dump never carries the record's rows, and every load drops them,
  a hand-made dump's included. A loaded scope's next destructive pass is refused and its next pass
  is a dry run. A PITR rewind can bring an older record back. A rewind of a scope that holds files
  writes the restore fence first, which holds for 35 days, longer than the record's window. A
  rewind of a scope with no attachment rows is not fenced. Either way the record only narrows what
  the other guards allow.

**The control plane keeps its admin-log rule beside it.** A deployment pushed before #2350 takes a
destructive pass without a record of its own, so the phase still asks for one only when the admin
log holds a dry-run row in the window. When the scope answers `orphan_sweep_unlicensed`, the phase
runs the dry run in the same visit and counts it in `awaitingDryRun`. Every other refusal is still
`refused`. The admin-log rows are written as before and stay the operator's record.

**Migration.** Nothing is backfilled. A scope that holds an admin-log row but no record of its own
(every scope, once its vertical is re-pushed) answers its first destructive request with
`orphan_sweep_unlicensed`, is dry-run in that visit, and is deleted on a later one.

## Runbook: turning it on

The phase is **off** by default. Turn it on in this order, one step at a time:

1. **Off.** `ORPHAN_ATTACHMENT_SWEEP` unset, or `off`. Nothing runs. A garbled value is off too,
   and the tail warns about it.
2. **Dry run.** Set `ORPHAN_ATTACHMENT_SWEEP=dry-run` and deploy the control plane. Every visit
   reports and changes nothing. Leave it for at least a day, so the window has covered a good part
   of the fleet.
3. **Read the admin log.** Filter by `sweepOrphanAttachments`. For each row, check that the keys
   look like `scope/<scopeId>/att/<ulid>`, that the scope is one you expect to hold files, and
   that the counts are plausible next to the scope's attachments. Also look at the tail and the
   pass's errors:
   - an `attachment-sweep` error saying a scope "holds attachment rows" but has no store is a
     missing store binding: re-push that vertical. (`noStore` is a vertical that keeps no files,
     and is not printed on its own);
   - an `unsupported` scope needs its vertical redeployed;
   - `refused` names the scopes the pass may not judge right now. The reasons:
     - an unsettled copy (#1722), which needs settling before the scope is swept;
     - a script deployed as another version than the directory says runs there. A promote that
       races the pass causes one, and the next pass reads again;
     - a script that carries no version identity (pushed before the version binding). It dry-runs
       and writes licence rows, then refuses every delete. It shows in the tail on every pass
       until the vertical is re-pushed;
     - a scope whose serving ref is no longer its vertical's current one. The pass is routed to
       that script but expects the bound version, so it is refused on every pass. This fails
       closed, and the scope needs its serving ref repaired.

   If anything looks wrong, set the mode back to `off` and stop.
4. **Delete.** Set `ORPHAN_ATTACHMENT_SWEEP=delete`. Scopes with a dry-run row from the last
   seven days are swept for real, up to 500 deletes per scope per pass. The rest are dry-run
   first. Keep reading the admin log: every delete row lists the keys that were deleted.

   **In delete mode the licence is issued by the sweep itself, with no person in between.** A
   scope that step 2 never reached, or whose dry-run row has aged past seven days, gets a dry run
   on its first visit. If that run finds orphans, it writes the row, and the scope's next visit
   deletes, possibly 15 minutes later. Your step 3 review covered only the scopes step 2 reached.
   For every other scope the dry run is a mechanical delay, not a review. Part A's guards still
   hold every committed row's bytes. On a deployment pushed with #2350 a delete takes only keys
   its scope's own dry run listed, which that dry run's admin-log row names. A deployment pushed
   before it can still delete objects that crossed the age floor after the dry run (see Known
   limits).

   The first delete-mode visit to a scope re-pushed with #2350 is a dry run, even when the admin
   log already holds a row for it: the scope holds no record of its own yet. The tail counts those
   in `awaitingDryRun`.

   **To stop deleting at any time**, set `ORPHAN_ATTACHMENT_SWEEP` back to `dry-run` (report only)
   or `off`, and deploy the control plane. The next pass deletes nothing. A pass already running
   finishes the scope it is on.

To pause without turning the phase off, set `ORPHAN_ATTACHMENT_SWEEP_BATCH=0`. The phase still
counts the eligible scopes and visits none. To resume, remove the override or set it above zero:
while it is `0`, no mode visits any scope. To turn the phase off instead, set the mode to `off`. A
condemned object that was not yet deleted stays condemned, and an upload of that id stays
refused. Nothing un-condemns an id, because the bytes behind it are already gone or going.

## Cost

Per visited scope, the control plane's reach makes three directory reads, and each writes one
access-log row (K-24):
- the scope's record;
- its tenant;
- either its vertical's serving pointer (a scope on a serving script) or its bound version (any
  other scope).

In delete mode the licence read adds a fourth. At the default batch of 25 and the 15-minute cron,
that is about 7,200 rows a day, plus 2,400 in delete mode. The access-log drain
ships up to 500 rows per pass (48,000 a day) to Tier 2 before it prunes them. The licence read
stays an audited read on purpose: one per pass for the whole window would carry a week of rows
with up to 500 keys each.

The scope's own licence (#2350) costs at most 1,000 small rows per scope (an id and a timestamp
each), written only when a dry run's finding changes or half the window has passed. A destructive
request the scope refuses for want of it adds one more call to the deployment in that visit, the
dry run. The directory reads are not repeated.

## Known limits

- A restore from a dump older than 35 days can bring back rows whose bytes were swept
  (`apps/docs/concepts/attachments.md`). A removed attachment has the same exposure.
- The window is random, not a schedule. A given scope is visited roughly every
  `eligible ÷ batch` passes, not at a fixed time.
- On a deployment pushed before #2350, the dry-run row licenses a delete of the scope's orphans
  at the time of the delete. Those may include objects that crossed the age floor after the dry
  run, not only the keys the dry run listed. A deployment pushed with #2350 deletes only the keys
  its own dry run listed.
- A dry run lists at most its `limit` (default 500) keys, so a backlog larger than that drains one
  dry run's worth at a time.
