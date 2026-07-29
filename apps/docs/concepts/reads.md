# Reads & scaling

Every scope runs a **strictly serialized executor**: one operation at a time, run to
completion ([Operations & the scope host](/concepts/scope-host)). That guarantee is what
lets module code do a read-modify-write without locks, transactions-for-concurrency, or
retry loops. It also raises the obvious question — *doesn't that mean one request at a
time?*

No. But the reason it doesn't is worth understanding, because the intuitive fix is the
wrong one.

## Serialization is per scope, not per system

The unit of serialization is the **scope**, and a scope is sized to the *consistency
domain* — one housing association, one branch, one clinic — never the whole tenant
([Tenants & scopes](/concepts/tenancy)). A thousand scopes execute a thousand operations
at once: separate execution domains, separate databases, possibly separate machines.
Only two operations *on the same scope* ever queue.

That queue is also much cheaper than it sounds. A scope's data is local to its execution
domain, so an operation is local SQLite work — microseconds to a couple of milliseconds —
not a network round-trip per query. And module code [cannot call the
network](/concepts/modules), so an operation can never hold the scope's turn while
waiting on a slow third party. The queue drains fast because operations are short.

## Why you can't just parallelize reads

The tempting fix is to let read-only operations run concurrently. It buys you almost
nothing.

A scope's execution domain is a **single isolate** — one thread. Admitting reads
concurrently would interleave them at `await` points, not run them in parallel. And SQLite
reads inside the domain are *synchronous local calls*, so there are no `await` points to
interleave at. Ten concurrent reads would still execute one after another, just with more
bookkeeping.

> **Reads get fast by getting short, not by getting concurrent.** A queue of 50 reads at
> 30µs each is invisible. At 2ms each, it isn't. Attack the duration.

## The three read paths

Reach for them in this order.

| Path | Latency | Consistency | Use for |
|---|---|---|---|
| **In-scope** (default) | µs | Serializable | Everything interactive |
| **External read model** (escape hatch) | ms | Eventually consistent | A scope whose reads outgrow its executor |
| **History tier** (Iceberg / R2 SQL) | seconds | Eventually consistent | Reporting, audit, cross-scope |

### 1. In-scope reads — the default

A read inside a scope is a local indexed query: one hop, strongly consistent, tens of
microseconds. Nearly all interactive reads belong here.

When a screen needs a shape the normalized tables don't serve cheaply — a dispatcher board
joining jobs, customers, technicians and totals — don't reach for a cache or a replica.
Keep a **projection table in the scope's own database**, maintained by an event consumer
in the same transaction as the write it derives from:

```ts
// The vertical's own module registration.
export const fsmModule: ModuleRegistration = {
  manifest: {
    // ...
    events: { emits: [], consumes: ['workorder.completed'] },
  },
  consumers: {
    // Fed by the engine's event. Own table, keyed by the engine's id —
    // never a column added upstream, never a read into engine tables.
    'workorder.completed': (ctx, event) => {
      const { workOrderId, completedAt } = JobCompleted.parse(event.payload);
      ctx.sql.exec(
        `UPDATE fsm_job_board SET status = ?, completed_at = ? WHERE job_id = ?`,
        ['completed', completedAt, workOrderId],
      );
    },
  },
};
```

The read is then one indexed scan of one flat table. There is **no staleness**, because
there is no second store — the projection commits with the write that caused it. This is
the same [side-table pattern](/concepts/modules) verticals already use to extend engine
entities, applied to read performance.

### 2. External read model — the escape hatch

If a scope's read volume genuinely outgrows its executor, the **outbox** already gives you
the way out. Event emission is transactional with the write it describes
([Events & audit](/concepts/events)), so a second drain sink can maintain a denormalized
read model in external storage (D1, KV) without any risk of a write that never reaches it.

::: warning Read-your-writes does not survive the crossing
D1's Sessions API provides sequential consistency *within D1's version space* — a
*bookmark* names a D1 version, and a replica waits to catch up before answering. But the
authoritative write lands in **the scope**, and reaches D1 only after the outbox pump runs.
At the moment the operation returns, there is no D1 bookmark that means *"after my write"*
— the two version spaces are unrelated.

So the guarantee you'd be counting on is exactly the one that breaks. Recovering it means
either mapping event id → D1 bookmark in the pump and waiting on that watermark, or
pinning a session's reads back to the scope for a window after it writes. Choose one
**before** adopting this path.
:::

Note what this implies: inside a scope you have something *stronger* than session
consistency for free — full serializability, one copy, no bookmarks to thread.
Read-your-writes isn't a problem you have; it's a problem you'd **acquire** by leaving.

### 3. History tier — not a read tier

Domain events flow to Iceberg on R2, queried through a tenant-scoping gateway. That tier is
columnar and seconds-scale by construction: it is for **reporting, reconciliation, audit,
and cross-scope history**. It is not a UI list view, and treating it as one is a category
error.

## A fourth surface: the per-tenant store

Distinct from the three read paths, a vertical can also hold a **per-tenant relational store**
(`tenantStoreNeed`, opened at runtime through `host.openTenantStore`) — one independent SQL
database per tenant that the platform mints and injects. It is an *own-store* concept, the way
a vertical might keep an auth database, **not** a read-scaling tier: reach for it when a
vertical genuinely needs its own relational store outside the per-scope execution domain, not
to make scope reads faster. Scope reads still follow the three paths above.

## Why not global read replicas?

Because the operational record shouldn't leave, for three reasons:

- **Residency.** A scope's `jurisdiction` is fixed at provisioning and its execution domain
  can never relocate. Replicating an `eu` scope's data to other regions contradicts that
  guarantee — and D1 offers location *hints*, not jurisdiction guarantees.
- **Consistency.** Read-your-writes does not cross the outbox, per above. Bookmarks cannot
  repair a boundary they cannot see.
- **The workload doesn't want it.** A scope maps to *one business*, whose users cluster
  around it. **Placing the execution domain well at provisioning beats replicating it.**

The honest carve-out: global replication earns its keep on **public, read-heavy,
staleness-tolerant surfaces** — customer portals, tracking links, availability views — where
the projection is a derived subset rather than the operational record, and traffic can dwarf
internal usage. That's a per-surface decision, not a platform read tier.

## When a scope really is too hot

Serialization bounds *write* throughput on a single scope, and at some point a scope can
outgrow its execution domain. The answer is never "shard the scope":

- **Split it.** A scope that's too hot is usually a consistency domain drawn too large. This
  is the same move as the [granularity rule](/concepts/tenancy) — and it's the right answer
  more often than it looks.
- **Migrate it to storage shape B**, where the execution domain becomes a control plane
  (hot state, locks) fronting a separate database for bulk storage and read replicas. The
  choice is per scope, and **invisible to module code**.

Both remain available for the same reason everything else here does: module code reaches
data through `ctx.sql` and nothing else, so what sits underneath can change without a single
operation being rewritten.
