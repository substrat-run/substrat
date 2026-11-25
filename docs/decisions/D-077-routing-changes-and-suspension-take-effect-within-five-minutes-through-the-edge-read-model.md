---
id: D-77
date: 2026-11-25
layer: plan
title: "Routing changes and suspension are designed to take effect within five minutes, through the edge read model; five minutes is the read models' target, and they are placed for latency and cost"
status: proposed
aliases: []
amends: ["D-41", "K-26"]
tracking: ["#3395", "#3397"]
---

# D-77 — Routing changes and suspension are designed to take effect within five minutes, through the edge read model; five minutes is the read models' target, and they are placed for latency and cost

> **Proposed 2026-11-25, not ratified.** The owner set the bound on 2026-11-25: a suspension and
> any other routing change may take up to five minutes to take effect, and performance and cost
> matter more than freshness. The reasoning is in [rfc/tenant-scale.md](../rfc/tenant-scale.md)
> (§2.1, §9). This record states the bound and the principle only. The mechanism that meets it on
> the request path, and the record answering K-26's cache question, belong to the router's edge
> read model ([#3395](https://github.com/substrat-run/substrat/issues/3395), implemented in
> [#3397](https://github.com/substrat-run/substrat/pull/3397) with its own record, "The router reads
> routes from a KV read model the directory publishes"). #3397 chooses a split of about four minutes
> (180 s in the router's memory, KV's 60 s `cacheTtl`) inside this target.

**Five minutes is the freshness target every read model the platform serves from is designed and
measured against.** A routing change, a suspension or its lifting, a deleted or new hostname, a
promote's per-version policy, a staff list, a projected count: each is designed to be at most five
minutes behind the object that decided it.

**The target is not a guaranteed maximum.** KV documents propagation of "60 seconds or more", with
no upper bound, so a cache budget alone cannot promise five minutes; a route can occasionally lag
longer. Each read model reports its measured lag against the target. A hard maximum needs a bounded
fallback in the mechanism, and is an open choice below.

**Where five minutes is enough, the cheaper and faster placement wins.** Design choices are ranked by
request latency first, then cost per tenant, then freshness inside the bound. A placement that is
fresher than five minutes but adds request latency or per-tenant cost needs a named reason.

**Suspension is enforced without a per-request read of any object.** The edge read model is
designed to stop routing a suspended tenant within the target. Nothing is added to a request to check
a tenant's status more freshly than that.

**A strongly consistent scope-side refusal is not required by this bound.** The scopes already refuse
once a lifecycle change is delivered to them (#1713). This record neither depends on that delivery
nor removes it; whether it stays a second lever, or becomes the lever for a bound tighter than five
minutes if one is ever wanted, is left to the owner.

**This amends D-41**, whose "settle once, for both" note tied the routing cache to the entitlement
projection: entitlements stay projected into scopes, and routing and suspension are held to the
five-minute bound by the edge read model. **It amends
[K-26](./K-026-one-environment-wide-router-verticals-are-unreachable-except.md)** on suspension
latency: a cached route may serve a suspended tenant for up to five minutes, and that is accepted.
How the router's cache is built, invalidated and split between memory and KV, and how
residency-pinned routes are read under
[K-36](./K-036-kv-s-disqualifier-is-missing-data-residency-not-a-regional-s.md), are #3395's record's to
decide.

## Why

**The owner chose cost and latency over freshness.** Every request outside the directory object's
colo pays a cross-continent round trip today (p50 41 to 297 ms by colo, measured in #3395). A bound
of minutes lets the route be served from the router's own memory, which removes that round trip and
adds no per-tenant cost.

**A bound of seconds would cost on every request.** KV documents propagation of "60 seconds or more"
and one write per second per key. Seconds would mean either a read of some object per request or a
fan-out per change that the request must wait for. Five minutes leaves room for an edge cache.

## Open choices for the owner

- Whether the scopes' existing lifecycle refusal (#1713) stays as a second lever beside the edge, or
  is reserved for a bound tighter than five minutes.
- Whether a suspended tenant's owner may still reach their data export through the dashboard.
- **Whether five minutes must be a hard maximum.** If so, #3395's mechanism needs a bounded fallback
  rather than the cache budget alone, for example a cached route that carries its own expiry and is
  revalidated against the authority once past it, at the cost of that read on the requests that hit
  an expired entry. If not, the target stands and the measured lag is reported against it.

## Not built

The bound is a rule. The mechanism is #3395's.
