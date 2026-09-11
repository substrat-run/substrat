# 9. The two clocks

Everything so far has been driven by a request. This chapter is the work nothing asks for:
retries, recurring jobs, reconciliation, reaping.

There are **two** background clocks, they run in different places, they do different work,
and the reference describes them in two pages that never sit next to each other. Getting
them straight is most of understanding how Substrat behaves when nobody is looking.

## Why an alarm and not a cron

Both clocks ship as Durable Object **alarms**. Three reasons, and the first one is
decisive:

**A dispatch-namespace script gets no crons.** A hosted vertical pushed into
Workers-for-Platforms does not honour `triggers.crons`. A DO alarm is the only timer such a
deployment can own. Everything else follows from needing a mechanism that works there.

**No overlap.** A cron fires on a schedule regardless of whether the last run finished, so
two passes overlap the moment one runs long. Here the next alarm is set **only after the
current pass settles** — so the interval is a **gap between passes, not a rate**. A slow
pass delays the next one rather than racing it.

**No configuration.** An alarm self-arms from code. There is no `wrangler.toml` entry to
forget in one environment and remember in another.

The first reason is also the limit of the argument, and it is worth being exact about which
clock it binds. Clock one runs inside a dispatched vertical, so the alarm is the only timer
available to it and there is no choice to make. Clock two runs on the platform's own
deployment, which is an ordinary worker and *can* hold a cron — and the hosted control
plane uses one, firing the same pass every fifteen minutes. So the no-overlap property
above is the alarm's, not the pass's: on the cron path a long pass can still meet the next
tick, and it is the pass itself that has to tolerate that.

And the loop is built never to die. A pass that throws whole is still caught, still reported
through `onPass`, and the alarm is **still re-armed** — the alternative being workerd's own
alarm retry, which would tighten the interval rather than keep it.

Arming is idempotent. `ensureArmed()` does not move an alarm that is already set, so it is
safe and cheap to call on every request, which is exactly how it is kept alive. Where a cron
*is* available, pointing `scheduled()` at `ensureArmed()` makes the cron a safety net that
recovers a lost alarm, never a second thing that runs passes.

## Clock one: the scope sweeper

**Where:** inside the vertical's own deployment, where its modules and its scopes' data are.
**Singleton name:** `scope-sweeper`.
**What it holds:** a roster in its own storage — `scope:<scopeId>` → `tenantId`.

This is the clock a vertical cannot do without, and the one most people mean when they ask
"what retries my failed delivery?".

One pass walks the roster, eight scopes at a time by default, and does two things per scope:

**`drainDue(tenantId, scopeId)`** — the executor retry driver from chapter 5. This is the
outbox's backstop: connector deliveries and executor effects that failed and are now past
their `next_attempt_at`. The pass returns `attempted` / `delivered` / `retrying` /
`deadLettered` summed across the roster.

**`runDueSchedules(...)`** — the recurring work a module declared in its manifest. Two
properties make that safe to run unattended:

- It runs under a **system actor**. Emitted events read as `{ system: '@your/module' }`, not
  as whichever admin last touched the data. Modelling a nightly job as a signed-in user is
  precisely the audit-trail laundering this exists to avoid.
- **`ctx.check` is still the only gate.** A schedule's declared permissions are granted to
  the module's system principal at provision, so the operation's own `assertAllowed` resolves
  the same way it does for any caller. A schedule can do exactly what it declared and no
  more — and revoking that grant for one tenant turns the schedule off for them, with no
  special "disabled" flag, because the operation simply fails its own check closed.

`cadence` is a **floor, not a promise**: a schedule fires no more often than `everyMinutes`,
and the sweep is what actually runs it, so sub-sweep cadences round up.

### The roster is maintained by the routes, not a directory

The sweeper does not enumerate anything. `/internal/provision` and `/internal/reconcile` call
`noteScope`, `/internal/delete-scope` calls `forgetScope`.

That is what lets a **CP-less vertical** — one with no control-plane binding at all — have
recurring work despite having no directory to read. It knows its scopes because it was told.

And the alarm follows the roster: **it lapses on an empty roster**, and `noteScope` restarts
the loop when the first scope arrives. A vertical with no scopes burns no alarms.

## Clock two: the platform sweeper

**Where:** the platform's own deployment.
**What fires it:** either trigger, over the same `runPlatformSweep`. The adapter ships
`definePlatformSweeperDO` — singleton `platform-sweeper`, the alarm loop clock one uses —
for a deployment that wants one. The hosted control plane instead points its `scheduled()`
handler straight at the pass, on a fifteen-minute cron.
**What it holds:** nothing — it reads the directory.

This is the fleet-wide maintenance pass. One pass, in this order, each phase recording
per-unit outcomes and **stepping over** failures rather than letting one sink the pass:

**1. Migration reconciliation.** First, deliberately. The drain phase below wakes scopes,
and waking migrates lazily — so running this after it would count every failed scope's
attempt twice per pass. It walks scopes behind the deployed frontier, retries them with
backoff, and flags the ones that keep failing. Scopes it leaves in a failed state are
**skipped by every later phase**: they fail closed, so touching them would only re-throw the
same migration error as noise.

**2. Executor drain.** `drainDue` over every active scope — the same call the scope sweeper
makes, here for deployments the platform drives.

**3. Platform-intent drain.** Pull and execute each active scope's pending intents from
chapter 5. Injected, because the kernel cannot reach a vertical's DO — the control plane
supplies a function that goes over the vertical's `/internal` surface.

**4. Provision reconcile.** The phase chapter 8 described: re-run `/internal/reconcile` on
every active install whose provision receipt is behind the version it now serves.

**5. Recurring schedules.** For each vertical that declares them, enumerate live scopes and
invoke each due operation. A fork or a snapshot is **skipped**, so a test copy never runs
real recurring side effects.

**6. Freshness expectations.** Record a verdict on event types that were expected to have
been seen recently — the "nothing ran" signal, which is otherwise invisible because absence
produces no row anywhere.

**7. Snapshot GC.** Delete expired forks. A preview with a TTL disappears here.

**8. Reap long-archived scopes.** See below.

**9. Reap tenants past their grace window.** After the scope reap, so a tenant's scopes are
gone before its row becomes a tombstone.

**10. Access-log drain and prune.** Ship staff access rows to durable storage, stamp them
drained, then prune what was shipped. The sink must be **durable before it resolves** —
everything downstream treats a resolved ship as proof the evidence survives outside the
directory, so a sink that buffers and returns early turns a retention policy into data loss.

## Reaping: the part that is not automatic

This is the mechanism the reference mentions in a single clause, and it deserves the space.

**Cloudflare never garbage-collects a Durable Object.** An archived scope's bytes persist
forever unless something explicitly wipes them. There is no platform-level cleanup to
inherit, and "we archived it" is not the same sentence as "it is gone".

So the platform sweep can do it — and it is **opt-in**:

```ts
runPlatformSweep(host, {
  reapArchivedAfterDays: 90,   // UNSET ⇒ the phase is skipped entirely
  reapDeletingAfterDays: 30,   // same, for tenants
});
```

Unset, the phase does not run. The reap is irreversible, so a deployment must **name a
retention window** before the sweep will ever destroy anything. The default is to keep the
bytes and let a human decide.

Three details you will meet in practice:

- A scope with a **null `archivedAt`** — archived before that column shipped — has no
  knowable age and is **never** auto-reaped. It must be reaped by hand.
- `reapScope` re-checks the `archived` status below the seam, so a row that changed
  underneath fails closed there rather than being reaped on stale information.
- The retention reap **forces past the bound-hostname guard**. That guard exists to stop an
  interactive per-scope mistake; a retention policy on an already-archived scope is a
  deliberate decision, not a slip.

The tenant reap composes the same seam: for each of the tenant's non-reaped scopes, archive
if needed, then reap, then clear the tenant's PII and config directory rows. The tenant row
survives as a **tombstone** — audit history, and a burned slug — and the admin log is kept
whole, because it is the compliance witness and is never swept.

What ends up gone: the storage. What remains: the fact that it existed, who ended it, and
when.

## Node, for completeness

Self-hosting on Node, neither DO exists. A server calls `startPlatformSweeper` at boot and
gets the same pass on an interval. The unit of work is identical — `runPlatformSweep` is
kernel code that holds no timer of its own. Only the thing that fires it differs.

That separation is why the sweep is testable at all: a test calls `runPlatformSweep` directly
and asserts the report, with no clock involved.

## Reading the result

Both sweepers return a report rather than logging and forgetting. `retrying` and
`deadLettered` are the numbers a health surface should show; `errors` is per-unit, so one
failed connector reconciliation does not hide behind a green pass.

A caller that ignores those learns nothing, which is exactly the failure mode the older
silent drain had — and why the reports exist in the shape they do.

---

**Next:** [Operating it →](/book/10-operating-it)
