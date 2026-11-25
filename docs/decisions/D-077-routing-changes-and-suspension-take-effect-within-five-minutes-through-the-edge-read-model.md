---
id: D-77
date: 2026-11-25
layer: plan
title: "Routing changes and suspension take effect within five minutes, through the edge read model; read models are held to that bound and placed for latency and cost"
status: proposed
aliases: []
amends: ["D-41", "K-26"]
tracking: []
---

# D-77 — Routing changes and suspension take effect within five minutes, through the edge read model; read models are held to that bound and placed for latency and cost

> **Proposed 2026-11-25, not ratified.** The owner set the bound on 2026-11-25: a suspension and
> any other routing change may take up to five minutes to take effect, and performance and cost
> matter more than freshness. The reasoning is in [rfc/tenant-scale.md](../rfc/tenant-scale.md)
> (§2, §9, §14).

**Five minutes is the freshness bound for every read model the platform serves from.** A routing
change, a suspension, a lifted suspension, a deleted or new hostname, a promote's per-version policy,
a staff list, a projected count: each may be up to five minutes behind the object that decided it. A
design that meets the bound more cheaply or with less request latency is preferred over one that is
fresher.

**Suspension is enforced at the edge.** The tenant's directory object
([K-68](./K-068-the-control-plane-directory-is-a-small-global-registry-and-one-directory-object-per-tenant.md))
is authoritative for its status. A suspension writes the status and its admin row and rewrites the
tenant's route entries in the edge read model as suspended. The router refuses a suspended route
without dispatching. The router's memory cache and KV's propagation together stay inside five
minutes, which bounds the router's own cache time (rfc §9). No per-request read of any object is
added, and no flag is fanned out to scopes.

**A scope-local suspension flag is an option, not a requirement.** If a tighter bound is ever
wanted, suspension can join the projection [D-41](./D-041-a-hosted-vertical-reads-its-entitlements-at-request-time-fro.md)
already fans out for entitlements, so a scope refuses as soon as its flag arrives. It costs one
fan-out per suspension and nothing per request. It is not built until a need for less than five
minutes is named.

**This amends D-41**, whose "settle once, for both" note tied the routing cache to the entitlement
projection: entitlements stay projected into scopes, and routing and suspension are settled by the
edge read model with the five-minute bound. **It amends
[K-26](./K-026-one-environment-wide-router-verticals-are-unreachable-except.md)** on suspension
latency: a cached route may serve a suspended tenant for up to five minutes, and that is accepted.

## Why

**The owner chose cost and latency over freshness.** A request reads the route from the router's
memory, so suspension at the edge adds nothing to a request and nothing per tenant. A
strongly consistent check would add a read of some object to every request or a fan-out to every
scope, for a freshness the owner does not need.

**KV and a memory cache can meet five minutes; they cannot meet seconds.** KV documents
propagation of "60 seconds or more" and one write a second per key. A five-minute bound leaves room
for both and for a router cache long enough to keep KV reads off most requests.

## Open choices for the owner

- How the five minutes are split between the router's memory cache and KV (rfc §9 proposes up to
  three minutes in memory).
- Whether a suspended tenant's owner may still reach their data export through the dashboard while
  suspended.
- Whether a security incident needs a faster lever than five minutes. The scope-local flag above is
  the realistic one: no Cloudflare mechanism found here clears a router's memory in every location at
  once.

## Not built

All of it. The edge read model itself is step 1's own record and pull request.
