---
id: D-77
date: 2026-11-25
layer: plan
title: "Routing changes and suspension take effect within five minutes, through the edge read model; read models are held to that bound and placed for latency and cost"
status: proposed
aliases: []
amends: ["D-41", "K-26"]
tracking: ["#3395"]
---

# D-77 — Routing changes and suspension take effect within five minutes, through the edge read model; read models are held to that bound and placed for latency and cost

> **Proposed 2026-11-25, not ratified.** The owner set the bound on 2026-11-25: a suspension and
> any other routing change may take up to five minutes to take effect, and performance and cost
> matter more than freshness. The reasoning is in [rfc/tenant-scale.md](../rfc/tenant-scale.md)
> (§2.1, §9). This record states the bound and the principle only. The mechanism that meets it on
> the request path, and the record answering K-26's cache question, belong to the router's edge
> read model ([#3395](https://github.com/substrat-run/substrat/issues/3395)).

**Five minutes is the freshness bound for every read model the platform serves from.** A routing
change, a suspension or its lifting, a deleted or new hostname, a promote's per-version policy, a
staff list, a projected count: each may be up to five minutes behind the object that decided it.

**Where five minutes is enough, the cheaper and faster placement wins.** Design choices are ranked by
request latency first, then cost per tenant, then freshness inside the bound. A placement that is
fresher than five minutes but adds request latency or per-tenant cost needs a named reason.

**Suspension is enforced without a per-request read of any object.** The edge read model stops
routing a suspended tenant within the bound. Nothing is added to a request to check a tenant's status
more freshly than that.

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

## Not built

The bound is a rule. The mechanism is #3395's.
