---
id: K-69
date: 2026-11-25
layer: kernel
title: "Nothing iterates over every tenant on a schedule: work starts from an event or the owning object's alarm, and a fleet-wide change is applied on each scope's next wake, warmed by a queue and counted"
status: proposed
aliases: []
amends: ["K-33"]
tracking: ["#3324", "#3331", "#3376", "#3388", "#3367", "#3369", "#1653"]
---

# K-69 — Nothing iterates over every tenant on a schedule: work starts from an event or the owning object's alarm, and a fleet-wide change is applied on each scope's next wake, warmed by a queue and counted

> **Proposed 2026-11-25, not ratified.** The design is in [rfc/tenant-scale.md](../rfc/tenant-scale.md)
> (§7.4, §7.5). It builds on Design B of
> [architecture/scheduler.md](../architecture/scheduler.md) (§4). Nothing in it is built.

**No scheduled job wakes or writes every tenant's or every scope's state.** Work is started by the
event that makes it due, and runs in the object that owns the state:

- A scope that enqueues a platform request, an undelivered event or a lake shipment kicks its own
  drain on commit (the pattern of #3388) and keeps an alarm set while anything is pending.
- A tenant's directory object ([K-68 (directory split)](./K-068-the-control-plane-directory-is-a-small-global-registry-and-one-directory-object-per-tenant.md))
  writes a due row for each connection's next sweep, with per-connection back-off (#3331) and one
  sweep per connection rather than per scope (#3376), and for its reaps, copy claims, retries and
  lifecycle deliveries, each written by the event that makes it due, in the same transaction.
- **An object keeps one alarm**, because a Durable Object holds one alarm at a time and a later
  `setAlarm()` replaces the earlier. The alarm is armed for the earliest due row; it runs every row
  that is due, then re-arms for the next earliest, or clears.
- An object with nothing due sets no alarm. An idle tenant costs storage only
  ([D-79 (idle tenant costs storage only)](./D-079-a-tenant-at-rest-costs-storage-only-and-every-platform-change-is-held-to-that.md)).

**The central pass becomes a safety net over a due index.** An object keeps one row in the index
(object, earliest due time), which lives in another object and cannot commit with the alarm, so the
order is fixed: **the index row is made durable first, then the alarm is set.** If the index write
fails, the object does not set the alarm and retries on its next invocation; its own due rows keep
the work. An index row with no matching alarm is harmless: the safety net kicks the object, which
re-arms from its due rows or clears the row. The object updates or clears its index row after its
alarm has run. The safety net runs hourly,
reads only rows overdue by more than an hour, and kicks those objects. Its work is the number of
alarms that failed, not the number of tenants. Reads of external datasets and of the index (the
daily cost rollup, the stale-scopes report) stay central; they wake nothing.

**A fleet-wide change is recorded once and applied lazily.** A promote, a fleet re-upload or a
backfill records a version or a backfill id in the registry. Each scope applies it on its next wake,
inside the migration pass it already runs on the first operation after a promote. A queue warms the
scopes active in the last 30 days so a person's request does not pay for it. Progress is durable:
each scope's applied version is recorded in its tenant's directory object, which projects a count per
(vertical, version) into the cross-tenant index, and completion is that count reaching the install
count, however late the last scope wakes. Analytics Engine, kept three months, carries only the live
progress chart. `PROVISION_RECONCILE_BATCH` and its pass phase are removed.

**This amends [K-33](./K-033-verticals-serve-in-place-from-one-stable-script-per-version-.md)** in one
part only: serving in place from one stable script, the per-scope migration pass and its PITR bookmark
stand; the provision-hook reconcile that follows a promote (#1172, #1653) moves from a batched pass to
each scope's next wake.

**Delivery engines are not decided here.** Whether event delivery and long connector jobs run on
Queues and Workflows is #3367's and #3369's question, under the one-model RFC's rule for Workflows.
This record requires only that whatever runs them is started by the event, not by a walk.

## Why

**The pass is the first thing that breaks.** At 311 scopes a pass runs a mean 275 s of a cron
trigger's 15-minute wall limit, and two runs on 2026-11-24 ended at 899 s. If it grows with scopes,
it reaches the limit near 1,000 scopes, about 600 tenants, long before the request path or the 10 GB
cap (rfc §5.4). A pass that must reach everyone has a ceiling; alarms do not.

**A promote that reaches 50 scopes a pass reaches 100,000 in 21 days.** Lazily, each scope pays at
its next request, the active ones are warmed in minutes, and an idle one pays nothing until it is
used.

**Today an idle tenant is woken 96 times a day per scope** by the platform-intent drain, and costs
about $0.38 a month in directory writes. The rule is what makes the free tier's cost storage only.

## Open choices for the owner

- The safety net's cadence (hourly proposed) and how overdue a row must be before it is kicked.
- Whether a version may be retired while idle scopes still run it, or whether retirement forces a
  warm-up of every remaining scope first.
- Whether the warm-up uses Queues now, or a self-kick chain until #3367 decides.

## Not built

All of it.
