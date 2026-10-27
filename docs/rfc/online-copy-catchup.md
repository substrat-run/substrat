---
status: proposed
layer: kernel
description: Copy a changing scope from paged base data and a bounded source change log, then briefly fence writes to finish and switch. Proposes a preview-first rollout, adapter contract, failure bounds, and decisions for #2450.
---

# RFC: online scope copy with catch-up

**Status:** proposed · **Tracking:** [#2450](https://github.com/substrat-run/substrat/issues/2450) ·
**Builds on:** [paged export and staged load](https://github.com/substrat-run/substrat/pull/2452)
and [durable copy jobs](https://github.com/substrat-run/substrat/pull/2458)

## 1. Problem and decision

A paged copy reads each page consistently, but its pages describe one moment only if the source's
write revision remains unchanged. `transferStep` compares every page with the first page, discards a
torn stage, and starts over. After three attempts it refuses with 409 and moves nothing. A recent CI
preview hit that refusal while copying a single page of roughly 3,400 rows. The source kept writing
during the attempts; scope size was not the cause. The rerun passed. The timing analysis is code
reading, not a measurement of source write rate or copy duration: the deployment sweeper begins
another pass two minutes after its previous pass ends, and the CLI's roughly 7.5-second progress
spacing includes a five-second poll wait. A quiet interval may exist between passes, but three
attempts can still meet one write burst. See the [issue
discussion](https://github.com/substrat-run/substrat/issues/2450).

Step 1 removed the whole-dump message ceiling. Step 2 moved long preview transfers into durable
jobs. Neither lets a copy finish while its source keeps changing. This RFC proposes a source-local
change log for the copy's lifetime, a paged base copy, replay into an inactive destination, and a
bounded final write fence. The intended result is a copy equal to the source at a named cutoff, even
when source writes occur during the base read.

There is a reasonable cheaper choice: document the 409 and ask callers to retry when quieter. The
evidence so far is one intermittent CI failure, a successful rerun, and a plausible gap between
sweeper passes. A retry spread over tens of seconds might reduce collisions without adding a write
path, retention state, or another destination load mode. It still depends on a quiet window and
cannot promise progress for a continuously written scope. The maintainer should accept the recurring
operational cost before enabling the proposal broadly (§8).

## 2. What can be reused

The hosted source already advances `_substrat_meta`'s write revision before a write, atomically with
that write, normally once per run or transaction. That is an **invalidation signal**, not a change
log: it says that something changed but gives neither the table and row nor a deleted row's
identity. The `_substrat_outbox` holds emitted events, but an in-place row update, an internal spine
write, or a write that emits no event need not appear there. Replaying it would omit data. The copy
ledger and load stamp protect ownership and restore; neither records changed rows. The cheapest
complete delta is therefore a temporary, source-local **key log**, rather than full row images on
every write.

The current destination stage stores positional cells without source row identity. Online replay
needs a keyed stage or an idempotent delta overlay. It cannot safely patch the present stage by
guessing that a staged row's position is its source rowid. The existing staged load, restore checks,
role repair, copy lease, and job alarm loop remain the transport and lifecycle; the new work is
capture, keyed replay, and finalization.

## 3. Capture and replay protocol

1. **Arm before the first page.** In one source transaction, create one active capture session,
   record its schema fingerprint and starting write revision, and install triggers on every table
   the dump carries. A trigger appends `(sequence, table, key, operation)` on insert, update, or
   delete in the same SQLite transaction as the change. A primary-key update records the old key and
   the new key. Rowid tables use their rowid; `WITHOUT ROWID` tables use their primary-key tuple.
   The page format and stage retain that identity, including rowid where needed. A table whose rows
   cannot be identified stably refuses online mode before copying. Source capture tables and
   destination staging tables are never part of a dump. The write-revision metadata row itself is
   omitted from capture; the cutoff marker is supplied separately. Schema changes, table
   replacement, and source restore invalidate the capture rather than attempting to replay DDL.
2. **Copy the base.** Export pages under the capture session and stage them under the existing stage
   identity. A write may occur between any two pages. It is retained in the log, so a revision
   change no longer restarts the base read. A page still carries DDL and columns; a schema mismatch
   refuses the session. The stage stays inaccessible to routing.
3. **Replay while writes continue.** Read log entries in sequence order, in bounded pages. For each
   affected key, read its current source row, or absence, and send an idempotent upsert or delete to
   the keyed stage. Reading a newer image early is safe: every subsequent source mutation has a
   later log entry. A delete followed by an insert, rowid reuse, and key changes must be covered by
   the ordered log and the final pass. Store the last applied sequence in the job and in the
   destination stage, so an answer lost after staging can be retried. Keep the existing lease
   renewal and six-hour job deadline.
4. **Finish at a cutoff.** When the remaining log is below a configured byte and operation budget,
   acquire a short, expiring source write fence. The fence waits for an in-flight source transaction
   and then blocks new data writes; it returns the final sequence, revision, schema fingerprint, and
   a token. Replay through that final sequence, verify there is no gap and that the schema still
   matches, and record that cutoff with the destination. If the fence expires or any verification
   fails, the destination remains inactive. Release the fence on every successful or failed exit. A
   preview fork may release it as soon as the complete cutoff is durably staged; the later restore
   and bind use that immutable stage.

The write fence **does not exist today**. A conditional `wipeCarriedCopy` compares the load stamp
and revision, but it does not reserve a write-free interval between the read and the directory
switch. The new fence needs a token and expiry on the source, enforced by the same SQL write
boundary as the revision. Its lease must be renewed only while finalization is making progress;
expiry releases writes automatically. It must not silently turn a writer's refused or deferred
operation into a successful one.

For a **carry**, the source cannot resume writes after the cutoff until the destination is ready and
the route has switched: later writes would be absent from the new live copy. Keep the fence through
the conditional source resolution and directory bind, then release it. The current
`commitStagedDumpChecked` loads and may migrate the entire destination in one transaction, so
holding the fence through that work is **not a short switch**. A general online carry therefore also
needs a prepared, inactive destination that can accept a bounded final delta after expensive loading
and migration. A same-schema destination can do this with an idempotent keyed patch before bind. A
schema-changing migration needs an explicit, tested delta transformation or a different preparation
strategy; until then it uses the existing retry/refusal path. Do not advertise an arbitrary
migrating carry as online on the strength of key logging alone.

## 4. Consistency and failure contract

For a completed online copy, there is a source transaction boundary **R** between arming and fence
release such that the **staged, pre-load** rows and schema of every included table equal the source
at R. The destination then applies the same load transformations as an ordinary restore, including
destination migrations, copied-work settlement, and grant re-pointing. The stage is never routed
while incomplete. For a preview, R is the fenced cutoff; source writes after R do not appear in
that preview. For a carry, R is the cutoff immediately before the source is resolved and the
destination takes the route; the fence prevents intervening source writes. This is a logical,
per-scope snapshot, not an atomic snapshot of excluded tables, external stores, or another scope.

Capture has hard bounds: one active session per source in the first slice, a maximum retained log
size, a maximum age, a maximum replay lag, and the job deadline. If a write would exceed the log
budget, the source write may proceed, but the capture is marked **invalid in that same
transaction**; the online job refuses, discards its stage, releases its fence, and leaves the old
route intact. It must never prune required entries and continue. A source that produces deltas
faster than replay can consume them fails after its lag or time bound, with the same outcome.
Transient page faults use the durable job's existing retry policy; a missing sequence, schema
change, expired fence, lost lease, or incompatible host is a terminal refusal. Stage cleanup and
capture cleanup are idempotent, with expiry as a backstop. The existing 409 remains the safe result
for unsupported copies.

## 5. Adapters, rollout, and cost

**Durable Object SQLite.** Triggers and the capture table live inside the source scope's SQLite.
They must cover all exported tables, including copied spine data, while excluding derived indexes,
stage storage, and other already excluded tables. The source SQL wrapper that advances the revision
must also invalidate capture for DDL, restore, and any write path triggers cannot cover. Export and
replay RPCs stay page-sized; no source or control-plane isolate holds a whole dump. The destination
gains keyed staging and an idempotent delta endpoint. A final fence is a scope-DO operation, not a
control-plane timer assumption.

**Node SQLite.** `SqliteScopeHost` currently exports a whole logical dump for its own snapshot path;
it does not implement the hosted paged transfer verbs or the hosted write revision. A shared
contract suite should test the capture, identity, replay, cutoff, and refusal rules against both
SQLite engines. The node implementation can use one read transaction or SQLite's backup facility for
its local snapshot path, but any node host offering this online protocol must implement the same
capture and fence semantics; a node-only shortcut cannot be the proof for the hosted path. Node
transactions must coordinate the fence with every scope writer, including host-maintained spine
writes.

Roll out by capability, with a **per-source flag**. Old source or destination hosts keep the current
paged or whole-dump path; the paged path retains its three-attempt refusal, and the whole-dump path
retains its size ceiling. A new host answers capability explicitly; a route miss is not interpreted
as online support. New control planes and jobs must preserve old serialized job states, use the old
transfer path for jobs already in progress, and never replay a new delta against an old destination.
Start with preview forks; their final delta reaches the staged **source** schema before the existing
restore runs destination migrations. Leave carry and rebind off until the short-switch primitive and
migration story are proven. Disabling the flag stops new captures; an already armed job finishes
under its recorded mode or fails closed.

With capture off, the proposed triggers should be absent and add **zero source writes**. With
capture on, each changed row produces one small log row plus its index/WAL writes; a key change
produces two. The existing revision update still occurs. The payload is table name, operation,
sequence, and encoded key, not a full row: approximately `fixed record/index overhead + table-name
bytes + key bytes` per changed row, with a second copy possible in WAL until checkpoint. Trigger
installation and retained log storage are additional one-time and bounded costs per copy. This is a
bound on *rows*, not a credible fixed byte count or throughput claim. Measure bytes written,
transaction latency, replay rate, and peak retained bytes on representative small and large rows in
both adapters before choosing limits. A full-row log would cost at least the changed row's payload
again per mutation and is not the first choice.

## 6. Fast proof before broad use

Use an injectable page boundary and clock, not timed sleeps. The adapter contract should interleave
an insert behind the export cursor, an update ahead of it, a delete, a primary-key change, and a
rolled-back write with base pages; the final copy must equal a source dump taken under the fence.
Check rowid and `WITHOUT ROWID` tables separately, and refuse unsupported identity or DDL. A lost
replay answer must not apply a delta twice. Force overflow and a replay rate below the injected
write rate; assert that the old route still serves and no incomplete destination is bound. Expire
the fence between final replay and switch and assert refusal. Run the hosted copy through workerd as
well as the node contract, since DO SQL and transaction boundaries are the production path. Count
write amplification and wall time in a benchmark, not in a flaky duration assertion.

## 7. Minimal first slice

Add capture and keyed replay behind the per-source flag for **preview forks**. Reuse
`ScopeCopyJobDO`, its lease, page budget and progress, and the existing staged restore. Arm capture
before page zero, replay until the tail is small, fence long enough to stage the final tail, then
release; the immutable stage can load and bind afterwards, including through its ordinary
destination migrations. When capture invalidates or overflows, report a 409, discard the stage, and
keep the preview on its prior route. Do not raise `TRANSFER_ATTEMPTS` as part of this slice. Carry,
unsupported row identities, and old hosts retain the current safe path while the
prepared-destination and migration question is resolved.

## 8. Open decisions for the maintainer

1. **Is this cost justified now?** Recommend measuring the busy-preview frequency and copy duration
   first, then enabling the flagged first slice if retries remain material. Keep the documented 409
   as the chosen limit if they do not.
2. **What is logged?** Recommend key and operation in a temporary source table, with source row
   images fetched during replay. Reject outbox-only replay because it does not cover every copied
   write.
3. **Which row identities qualify?** Recommend rowid or declared primary key, with an explicit
   refusal for tables whose identity cannot be preserved by both page export and stage replay. Do
   not infer identity from page position.
4. **What bounds stop a stalled copy?** Recommend one capture per source initially, fixed byte and
   age limits, a small final-tail budget, and the existing job deadline; choose numeric limits from
   the proposed benchmark. An overflow invalidates the capture in the write transaction and never
   drops required entries silently.
5. **How does a carry switch briefly?** Recommend a prepared destination with a bounded final keyed
   patch and a source fence held through conditional resolution and bind. Defer online mode for
   schema-changing migrations until a migration-aware final patch is demonstrated; retain the
   current fail-closed path meanwhile.
6. **How is compatibility signalled?** Recommend explicit source and destination capability plus the
   per-source flag, with old jobs completing in their recorded mode. Do not infer support from
   deployment age or a successful first page.
