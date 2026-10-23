---
id: K-57
date: 2026-10-23
layer: kernel
title: "A semantic index is scope-local; a semantic read is declared eventual; an external index only as a scope-store driver"
status: accepted
aliases: []
amends: []
tracking: ["#1576"]
---

# K-57 — A semantic index is scope-local; a semantic read is declared eventual; an external index only as a scope-store driver

**Semantic matching lives inside the scope's boundary.** When it is built, the kernel owns a scope-local vector table, excluded from dumps like the FTS index, and fills it **asynchronously** through a host-supplied **embedder seam**, the pattern K-43 set for attachment text: the kernel holds the table, the job and the outcome; the host passes the embedder in; the kernel never imports a model. Model calls are governed like any other platform model call (D-59's provider rows) and stay within the scope's jurisdiction. A scope that outgrows an in-scope table moves its index to a **scope-store driver** (K-49, D-63), which implements the reserved `erase`, `export`, `import`, `wipe` and `size` operations like any other store. The index is **never** a shared multi-tenant service.

**A semantic read is a separate, declared, eventually consistent call.** It reports its freshness, per entity and as how much of the scope is still unindexed, so "not indexed yet" is never read as "no match". Like `ctx.search`, it checks no permission itself: the operation's `assertAllowed` comes first, and a vertical with narrowed grants filters what it hydrates. Two things are decided with the read contract (#2500), not here: whether the semantic read filters for the caller as `ScopeAttachments.search` does (K-43), and how its freshness figures are scoped for a caller who cannot read the whole scope. `ctx.search` and its FTS index stay the default and stay read-after-write correct. Merging keyword and semantic results (hybrid ranking) is the caller's in v1.

**Built on a trigger.** Nothing is built until a vertical needs meaning-matching over prose or uploaded documents. Before building, a spike measures brute-force similarity at 1k, 10k and 100k chunks per scope, which decides whether the in-scope table or a store driver is the first shape.

## Why

**The guarantees are the scope's, so the index has to be.** A scope's data is erased, exported, wiped, forked and restored as one, inside one jurisdiction. A vector index outside that boundary is a copy of the scope's text that none of those paths reach unless each one is taught to, and a shared index across tenants makes every one of them a filter rather than a boundary. Keeping the index in the scope, or in a store driver that answers the same reserved operations, keeps the index inside the reach of the scope's erase, export, wipe and residency paths. Reach is not correctness: an asynchronously filled table keeps the embedding of an erased field until something removes it, which the trigger-maintained FTS index does not (kernel-design §13.1 records a second copy that erasure missed, #1600). And because the table is excluded from dumps, an import, restore or fork brings it back empty, to be re-embedded. Both are design work for #2500.

**Eventual consistency is a contract, not a footnote.** The FTS index is trigger-maintained, so a picker sees what was just created. An embedder runs later and can fail, so a semantic read cannot promise that. Declaring the read as its own call with a freshness report is what stops a caller treating an index that has not caught up as an empty result, and it leaves the read-after-write path untouched.

**The earlier deferral blamed the wrong thing.** Semantic search was deferred because Durable Object SQLite rejects `vec0`. That blocks one implementation, not the decision: brute-force similarity over a table, or a store driver, needs no extension. The spike answers how far the first one goes.
