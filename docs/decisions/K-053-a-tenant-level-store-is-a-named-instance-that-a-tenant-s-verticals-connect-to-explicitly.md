---
id: K-53
date: 2026-10-15
layer: kernel
title: "A tenant-level store is a named instance that a tenant's verticals connect to explicitly"
status: accepted
aliases: []
amends: ["K-49"]
tracking: ["#2207", "#2303"]
---

# K-53 — A tenant-level store is a named instance that a tenant's verticals connect to explicitly

> Accepted 2026-10-15, from the maintainer's answers to the 22 questions of [the store-instances RFC](../rfc/store-instances.md) §12 (recorded in its §12.1). It amends [K-49](./K-049-a-scope-store-is-a-platform-run-object-per-scope-reached-by-its-own-door.md): K-49 covers scope-grain stores, and this record covers tenant-grain ones.

**A store is backed by a driver.** A driver is the platform-registered, pinned code that backs a store. It is what the code and the ratified text of K-49, K-50, K-52 and D-63 call a *kind*. They keep saying "kind" until a separate rename lands. This record uses the new word and changes nothing else.

**A driver declares its grain, and the vertical never chooses it.** The driver's registration says `grain: 'scope' | 'tenant'`, and that is reviewed with the registration. The grain of the first driver is decided before that driver is registered. A driver that needs both grains registers twice, under two ids. A scope-grain driver keeps K-49 and K-50 unchanged: one object per (tenant, vertical, scope, binding). Everything below applies to tenant-grain drivers. The vertical's declaration (`runtimeNeeds.scopeStores: [{ binding, kind }]`) and its door (`getScopeStore`) are the same for both grains.

**A tenant-grain driver backs named, tenant-level instances.** A tenant can hold several instances of a driver. Each has a ULID id. Its display name lives in the directory only and never appears in an object or script name. Only a tenant admin creates an instance. A vertical's provisioning never creates one. An instance's jurisdiction is fixed when it is created.

**A vertical reaches an instance only through an explicit connection.** A tenant admin connects one installation scope's declared binding to one instance. A tenant has at most one live connection per (scope, binding). The act needs a **new connection permission key** held by owner and admin. That key reaches the dashboard's `PERMISSIONS.md` through `lint:permissions`, so the human permission-diff checkpoint sees it. Every connect, disconnect and change to reads leaves an admin-log row. A connect is refused when:

- the binding's driver is not the instance's driver;
- the scope is not primary;
- the vertical is not installed in the tenant;
- the instance is not active;
- the scope's jurisdiction is not the instance's.

When a call reaches an unconnected binding, it gets a named refusal before anything is signed. It never gets an empty store.

**Partitions are keyed (instance, scope, binding), and the platform addresses them.** The router builds the object name from facts it asserts itself: the dispatch's tenant, and the connection row the directory holds for the dispatch's own (scope, binding). The vertical chooses none of these. A vertical's call therefore reaches its own partition and nothing else. Resolution goes through the directory on every dispatch and fails closed: an ended connection, an instance that is not active, or a driver mismatch means the binding is absent. A partition outlives its connection. A reconnect of the same (scope, binding) to the same instance revives it, with its data.

**Reads of another partition are opt-in.** A connection reads nothing from any other partition until a tenant admin enables reads for that connection. Even then, it may call only the read operations the producing installation declared shareable, and only operations the driver's registration lists as read-only. A read grant cannot leave the reader's tenant or instance. The control plane refuses such a grant. The router also drops one at resolution, and it takes the tenant and the instance in the name from the reader's own resolution, never from the grant. Reads across partitions are limited to **non-personal shapes, permanently**: the erasure fan-in below reaches the partitions a scope wrote, never a copy another vertical made from them.

**A read needs envelope changes that K-52 does not yet have.** Signing a read of another partition requires two things: a third audience for it (the RFC calls it `reader`), and the caller's vertical, scope and connection inside the signature. K-52 (proposed, not ratified) defines the audiences as `caller` and `platform` only. Both changes therefore **require a K-52 amendment**, to be recorded with the instance implementation. Nothing here assumes them before that.

**One store script per (driver, tenant), and strictly within a tenant.** A tenant-grain driver's code never runs in a script that holds another tenant's objects. That is what keeps tenant isolation below the envelope. The script name is a reserved form, held injective against the per-(kind, vertical) names. Separation inside a tenant, between partitions and between instances, is **held by review**: they share the script and may share an isolate. The noisy-neighbour risk inside a tenant is accepted for the first driver, and measured. **B′, a script per partition, is required before any driver written outside this repo is registered at tenant grain.** That is the same condition #2302 sets for scope-stores Q3.

**The lifecycle is the platform's, per partition:**

- **Erasure fans in.** A shred in a scope calls `substrat.erase` on every partition that scope's connections name, whether a connection is live or ended while its partition still holds data. The subject key is destroyed only after each of those partitions has answered. An unreadable connection history counts as "may hold", and an unreachable instance keeps the key and answers 503. Restoring an instance re-erases every subject shredded in any scope of the tenant.
- **A scope wipe or reap never wipes an instance.** A reaped scope's partitions are removed, and an archived scope's are kept.
- **A disconnect keeps the partition.** The partition becomes unwritable and is readable only through existing grants. Deleting it is an explicit tenant-admin step, done in the export, wipe, drop order.
- **The last shareable list stands.** After a producer's connection ends, its last recorded list still bounds reads, and an admin may narrow it but never widen it.
- **Previews, forks and snapshots reach no instance in v1.**
- **Deleting an instance that has live connections is refused**, and the refusal names those connections.

**The tenant-facing half is shared with auth-server-style instances.** There is one directory of tenant-level instances, one connection permission and one dashboard door, so a tenant admin sees one place where verticals are connected to tenant-level things. The transports stay separate. OIDC verification and the platform-routed envelope do not become one protocol.

**Background writes are deferred to a separate record.** Whether a tenant-grain driver gets a door for consumers and schedules is decided in its own record. That record must be decided **before a tenant-grain driver's first tenant**. Until then, a tenant-grain store is reached only from an operation in a scope.

## Not decided here

- K-52 is not ratified by this record.
- D-63's pin has a proposed `schema` integer (#2300), which this record does not state as decided.
- The quota numbers wait for a real Workers for Platforms account (RFC §13).
- The isolation requirements of RFC §11.1 gate any driver written outside this repo.
- The rename of "kind" to "driver" in the code and the ratified records is a separate pull request.

## Why

**Only a tenant-level instance meets the requirement with a synchronous write.** A store per (tenant, vertical, scope, binding) can never be reached by two verticals. Platform-side ingestion gives up the write from the operation a user is waiting on. Placing an instance in one vertical's script would put other verticals' data into a script that runs for every tenant of that vertical.

**The platform builds the name, so a vertical cannot address what it was not connected to.** That holds whether or not the driver is correct. It also makes the partition the platform's unit of wipe, export, size and erasure.

**Reads are opt-in and non-personal because no one else can bound them.** A read runs with the reading vertical's authority, not the person's standing in the producing vertical. Principals are per scope, and no subject identity spans verticals. So the producer's declaration, an admin's explicit consent and a permanent non-personal limit are the bounds that exist.

**A script per tenant is where tenant isolation stops depending on review.** Within a tenant, review is accepted for the first driver, because the data is what that tenant chose to share across its verticals. A driver written outside this repo is not held to review alone, which is why B′ comes first for it.

The argument, the options weighed and the evidence are in [the RFC](../rfc/store-instances.md) §§4–11 ([#2303](https://github.com/substrat-run/substrat/pull/2303)).
