---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

kernel: an entity's version is the last event's ULID (`ctx.versionOf`)

Two users edit the same customer and the last write silently destroys the first. Nothing in
the platform could refuse that, because nothing could say which revision of a row a caller
had read — no entity table carries a version, and `precondition_failed` (412) has sat
declared-but-unraisable in the error taxonomy waiting for one (#901, unblocking #129).

**The version already existed.** `_substrat_outbox` has recorded `entity_type` and
`entity_id` against a monotonic ULID `id` since it was written, on every event, for every
module. Every mutation that followed the fat-event rule already versioned the thing it
touched; nothing had ever read it back. So this adds `ctx.versionOf(ref)` — the ULID of the
last event about an entity, or `null` if there has never been one — and an index that makes
it a seek.

**The rejected design is the interesting half.** This began as a `_version INTEGER` column
on every entity table, added at the moment DDL derivation makes it cheap. That was filed as
time-boxed and urgent, and it was the wrong shape for two reasons that are not about cost.

The only way to make a column unforgettable is a trigger emitted per table — and a trigger
is SQLite, replicated into ~73 tables, re-derived for every vertical authored afterwards.
The scope-host contract is not a SQL contract; `query`/`exec` are how *these two adapters*
happen to serve it, and a guarantee expressed as DDL cannot be honoured by an adapter that
is not SQLite. The spine version is one method with an adapter-private implementation: same
guarantee, no vertical carries it, no adapter is bound to SQLite to provide it. It also
means there is no window — a spine fact is not time-boxed by DDL derivation at all, so this
no longer gates that work.

The ULID earns the job on four properties, each verified rather than assumed. It is
**monotonic** (`ulid()` uses the spec's monotonic factory, which the outbox's `ORDER BY id`
already depended on, so two events in one millisecond still compare in creation order). The
outbox is **never pruned** — it drains, it does not expire. It **survives erasure**: a shred
nulls `payload` and keeps the row, so an erased entity can still refuse a stale write rather
than failing open at the worst possible moment. And it is **unforgeable**, because module
code cannot write `_substrat_*` — a column would have needed a trigger clever enough to
reset a forged value.

**Two properties that are not the happy path, both pinned by the contract suite on both
hosts.** A shred does not take the version with it. And a mutation that emits nothing does
*not* move it — that is the honest hole, since "every mutation emits a fat event" is
enforced by review and not by `boundary-lint`. The answer is not a change here: it is that a
declared `concurrency` must be compile-checked against the operation's declared `emits`
(#129), which is strictly more than the column would have given — a trigger guarantees the
column moved, never that the operation announced what it did.

One behavioural difference from a per-row counter, documented at the seam rather than left
to be discovered: **any** event about the entity moves the version, including one that
changed nothing the caller read. A precondition built on this is conservative — it can
refuse a write that would have been safe, and cannot admit one that would not.

The index (`_substrat_outbox (entity_type, entity_id, id)`, `id` last so SQLite walks to the
end of the matched range instead of aggregating over it) lands in both adapters' spine DDL,
which is all `IF NOT EXISTS` and re-applied on every cold start — so existing scopes pick it
up with no migration and no backfill. The outbox had no index at all before this; it was
only ever read in drain order, which is its primary key.
