---
id: D-77
date: 2026-11-25
layer: plan
title: "Suspension is enforced in the scope, from a flag projected like entitlements, not at the edge"
status: proposed
aliases: []
amends: ["D-41", "K-26"]
tracking: []
---

# D-77 — Suspension is enforced in the scope, from a flag projected like entitlements, not at the edge

> **Proposed 2026-11-25, not ratified.** The reasoning is in
> [rfc/tenant-scale.md](../rfc/tenant-scale.md) (§9). Nothing in it is built.

**A suspended tenant is refused by its scopes, not by the router.** The tenant's directory object
([K-68](./K-068-the-control-plane-directory-is-a-small-global-registry-and-one-directory-object-per-tenant.md))
is authoritative for the tenant's status. A suspension writes the status and its admin row, then fans
a suspension flag out to each of the tenant's scopes, an intent per scope with its own retry, the way
[D-41](./D-041-a-hosted-vertical-reads-its-entitlements-at-request-time-fro.md)'s entitlement
fan-out works. A scope holding the flag refuses every request before any operation runs. Lifting a
suspension clears the flag the same way.

**The edge is told too, and decides nothing.** The route in the edge read model is updated, so the
router stops dispatching within KV's propagation window. That saves the work. It is not what enforces,
because KV is eventually consistent: a write may take 60 seconds or more to be visible elsewhere.

**An immediate suspension waits for every scope.** The console reports it done only when every scope
has acknowledged the flag, and lists the scopes that have not.

**This amends D-41**, which projects entitlements into scopes: suspension joins that projection,
which is the "settle once, for both" D-41 recorded. **It amends
[K-26](./K-026-one-environment-wide-router-verticals-are-unreachable-except.md)** on suspension
latency: the router caches, and the scope decides, so a cached route no longer blunts a suspension.

## Why

**The edge read model cannot be where a decision is enforced.** KV allows one write a second per key
and may take a minute or more to propagate. A suspension enforced there is late by an amount nobody
controls. A scope reads its own projection in the same transaction as the request it refuses.

**The mechanism exists.** Entitlements already fan out to scopes, are read locally and fail closed.
Suspension is one more projected fact, not a new mechanism.

## Open choices for the owner

- Whether a suspended tenant's owner may still export their data through the dashboard while
  suspended.
- The bound on fan-out delivery that is acceptable before staff are alerted.

## Not built

All of it.
