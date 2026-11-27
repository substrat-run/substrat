---
id: K-74
date: 2026-11-27
layer: kernel
title: "A broker per tenant and app owns every message a scope sends, once the scope has handed it off"
status: accepted
aliases: []
amends: ["K-69"]
tracking: ["#3463", "#3467", "#3468", "#3469", "#3470", "#3471", "#3472", "#3473", "#3474"]
---

# K-74 — A broker per tenant and app owns every message a scope sends, once the scope has handed it off

> **Proposed and ratified 2026-11-27** by the owner, as Track A of [rfc/broker-and-tenant-isolation.md](../rfc/broker-and-tenant-isolation.md)
> (§4, §9.2, §11). Nothing in it is built: #3467–#3474 build it. Tracks B, C and D of
> that RFC are not decided here.

**Every message a scope sends leaves through a broker, one Durable Object per (tenant, app).** That
covers a scope's platform intents, its events to other apps, its connector deliveries, the replies it
sends, and its outbox rows shipped to the lake. An operation writes the message to the scope's outbox
in the same transaction as its data. Right after commit the scope hands the message to its broker.
The broker stores it and acknowledges, and from the acknowledgement the broker owns it: delivery,
retries, ordering, pairing a reply with its request, and dead letter. A handoff that fails is retried
from the scope's own alarm, which `scope-wake.ts` already arms after a commit that leaves work, and
the broker drops a duplicate by message id. A pass over scopes is never the delivery path. It may
remain only as the last resort for a platform bug, and it is named as such where it runs.

**Delivery is effectively once inside the platform, and at least once outward.** Every hop (scope to
broker, broker to the router, the router to the receiving app's broker, that broker to its scope)
acknowledges and drops duplicates by message id, so a consumer's effect is applied once per message.
A call to the internet is delivered at least once, with an `Idempotency-Key` the kernel sets, so the
receiver can recognise a repeat. Nothing in the platform promises "exactly once end to end".

**A scope's outgoing work is not refused because a queue is full.** Once the broker owns delivery for
a tenant, `ctx.requestPlatform` no longer refuses at `MAX_PENDING_PLATFORM_REQUESTS`, and routed
connector deliveries no longer wait on `MAX_PENDING_CONNECTOR_DISPATCHES`. Both caps, and the callers
that route around them, are removed once every tenant is switched. The broker's own storage is
bounded by acknowledgement downstream (K-70), and an idle (tenant, app) arms no alarm and costs
storage only (D-79).

**What a sender, a receiver and the platform each decide.** The sender declares, per message type,
how long a message lives, whether a repeat is safe and its ordering key. The receiver declares, per
subscription, its attempts, its backoff and whether it needs order. Undeclared, the platform retries
5xx and timeouts, fails 4xx and schema errors at once, treats `429` and `Retry-After` as slow down,
and pauses a receiver after a run of failures without spending the paused messages' attempts. Order
holds only where declared, per (receiver, key), so a stuck key stops only its own lane. A message the
broker gives up on is kept 14 days in the tenant's dead letter, visible to the tenant's admin with
content and to the platform without, can be resent or discarded, and is reached by subject erasure.
All of it is part of the AsyncAPI contract the platform generates.

**The lake is one subscriber.** The broker hands each message to Pipelines as one receiver among
others, right after commit, with the payload sealed per subject when #3464 lands. The control plane's
drain stops shipping a scope's outbox once its tenant is switched.

**The pure SQLite host has the same contract.** It runs an in-process broker, and one suite in
`packages/contract-tests` holds both adapters to the handoff, the duplicate handoff, delivery and a
retried failure, as K-6's suites do.

**It rolls out per tenant, in shadow first.** Behind a switch per tenant, off by default, the broker
first delivers beside the existing drain to a recorder, and the two are compared. A second switch
makes the broker the real path for a tenant, and switching back is the lever. The old paths are
removed only once every tenant is switched.

**What this amends in K-69.** K-69 says work starts from an event or the owning object's alarm, never
a scheduled walk over tenants. This record decides who that work is for delivery: the scope's commit
hands off, the scope's alarm retries a failed handoff, and the broker's own alarm drives retries and
pauses. The control plane is no longer the drainer of a scope's messages.

**Not decided here.** Resuming a waiting write as a kernel process (Track C), facets (Track B) and the
egress gate and credential injection (Track D) are separate records. The reply pairing this record
keeps hands an answer to a resume target that is generic: today a K-62 attempt's record operation.

## Why

**The mechanisms grew one at a time and fail at their joins.** A scope's outgoing work waits in a
table capped at 32, its connector deliveries in a second room of 32 (#3365), and its outbox for the
lake drain. The control plane is the only drainer, first through the `*/15` pass and now also through
the kick `scope-wake.ts` sends after a commit. A large import arrives in batches the cap bounds, and
the cap is a refusal every caller has to route around (`runPurgePass` defers on it, #2506, #2517).
A full room once dead-lettered connector deliveries without anyone seeing it (#3365). One owner after
commit, with acknowledgement, dedup and a visible dead letter, removes the cap as a refusal rather
than raising it.

**The control plane should not be every scope's drainer.** The tenant-scale RFC moves the platform
away from objects that serve every tenant (K-68, K-69, D-79). A drain that every scope's every message
passes through is the same shape. Per (tenant, app) the load divides with the tenants and apps that
produce it, and the broker can sit in the app's own script, so the handoff is a direct call.

**Why not one broker per tenant.** A large tenant's traffic would pass one object that takes one call
at a time. Per (tenant, app) it divides naturally. Its throughput under a large import is measured in
the shadow phase before any tenant is switched (#3471).

**Why not Cloudflare Queues or Workflows.** Queues are shared by the whole account and unordered; if
tenants' data is not to mix they carry only references (#3367). Neither commits with a scope's
transaction, so the outbox would still be needed in front of them, and the pure host has neither. The
contract half of #3367, AsyncAPI generated from what an app declares, stands and is what this record
emits into.

**Why the delivery semantics are stated exactly.** "Exactly once end to end" is not deliverable to an
outside service, and a reader who believes it builds on it. Dedup by message id at every hop is what
the platform controls, and an `Idempotency-Key` is what it can offer a receiver it does not control.

**Why in shadow first.** The drain carries production traffic today. Running the broker beside it, to
a recorder, shows differences in delivery and latency per (tenant, app) before any tenant depends on
it, and the per-tenant switch is a way back that does not need a deploy. It is the pattern the
directory's dual-write already uses.
