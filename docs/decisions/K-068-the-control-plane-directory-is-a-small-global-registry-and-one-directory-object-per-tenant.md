---
id: K-68
date: 2026-11-25
layer: kernel
title: "The control-plane directory is a small global registry and one directory object per tenant, and a change across them commits its intent first"
status: proposed
aliases: []
amends: []
tracking: ["#3325", "#3326", "#1343"]
---

# K-68 — The control-plane directory is a small global registry and one directory object per tenant, and a change across them commits its intent first

> **Proposed 2026-11-25, not ratified.** The design, the numbers and the migration order are in
> [rfc/tenant-scale.md](../rfc/tenant-scale.md) (§7, §12). Nothing in it is built.

**On the Cloudflare adapter, the directory is split in two kinds of Durable Object.** A **global
registry** (one object) holds only what must be unique or the same for every tenant: tenant ids and
slugs, hostname uniqueness, verticals, versions (manifests in R2 by digest), channels and their
history, scope stores, wire auth, vertical owners, store driver releases, identity pools, markup
defaults and issue groups. **One directory object per tenant** holds everything that is the
tenant's: its status and name, scopes, the binding half of its hostnames, roles, tuples, orgs,
entitlements, identities, connections with their sealed secrets, keys, grants and connector state,
connect links, impersonations, switches, fences, findings, tenant and blob store refs, subject keys,
lifecycle receipts and revisions, and a bounded window of its logs and meters
([K-70](./K-070-data-that-grows-with-tenants-times-time-leaves-the-sqlite-objects-each-object-keeps-a-bounded-recent-window.md)).

**Every read-decide-write that concerns one tenant stays one transaction**, because it stays in one
object: a scope transition, a role definition or seat with its reserved-key refusal, a membership
fence, a connector-state compare-and-swap.

**A change that crosses two objects commits its intent first.** This is
[K-64](./K-064-a-scope-has-a-declared-type-and-may-have-a-parent-and-nothing-crosses-a-scope-s-boundary-inside-its-transaction.md)'s
rule applied to the platform's own objects. Six write paths cross: tenant create, tenant reap,
tenant status (a projection), and hostname bind, update and delete; a provisioner creating a managed
tenant is a seventh. The deciding object commits the intent and its admin row; host code makes the
second call; the first object records the outcome. A hostname is claimed in the registry, whose
claim refuses one another tenant holds, then bound in the tenant's object. A claim never confirmed
is released after a lease.

**Cross-tenant reads read a projection, never the tenant objects.** Staff lists and search read one
D1 database holding one row per tenant, one per hostname and one per (login, tenant), projected by
each tenant object through an outbox. Every such list says when its rows were true. A staff action
opens the tenant's own object, which is authoritative.

**Neither object is on the request path.** The router reads the edge read model, step 1 of the
migration, designed in its own record.

**`adapter-sqlite` keeps one database.** The split is the Cloudflare adapter's. The contract suites
hold the end state of every crossing change on both adapters, and the Cloudflare adapter adds a
fault-injection suite that crashes between the halves. `HostAdmin` changes only additively:
cross-tenant list reads return `asOf` and `consistency: 'eventual'`.

**The words of D-75 stand.** The tenant directory object is the platform's record of a tenant. It is
not an app's scope, and in particular not D-75's home scope.

## Why

**The load is not routing.** On 2026-11-24 the directory took 419,156 requests against 19,615 routed
requests, about 21 to one, and its 1.3 GB at rest is mostly logs. One object every tenant's data and
every platform job passes through is what ran out of memory twice (#2868, #3324) and what a 10 GB cap
and a 1,000-requests-a-second soft limit bound. The fixed part per tenant is about 25 KB, so it is
not the size of the registry that forces the split but the throughput and the growth (rfc §5).

**The tenant is the grain where the invariants already are.** Of 52 transaction sites, the
read-decide-writes that matter are each about one tenant. Splitting by tenant keeps all of them
single-object, and leaves only uniqueness global.

**Status and name belong to the tenant, not the registry.** The registry would otherwise be written
on every suspension and read on every tenant page. Putting the authoritative copy in the tenant's
object keeps the registry small and rarely written.

**D1 for the index, not for the directory.** D1 has no interactive transaction (rfc §6), so a
read-decide-write cannot be written against it. The index is written by projection and read by
staff, which is what D1 is good at.

## Open choices for the owner

- Whether the registry keeps a projected copy of tenant status for staff tools, or only the index
  does.
- Whether the due index (K-69) lives in the registry or in the D1 index.
- How long a tenant's reads stay on its object with the old directory dual-written as the fallback,
  before writes cut over (rfc §12, step 3e).
- Whether #1343's dashboard directory is moved straight into the tenant objects (recommended) or
  first into today's shared directory as its brief planned.

## Not built

All of it.
