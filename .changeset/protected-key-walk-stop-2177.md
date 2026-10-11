---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

A key that a declared entity-grant shape protects now reaches a record of the shape's type only through the shape's own grant on that record (#2177). The protected keys are those of a `'grantee'` shape and of a binding shape. Direct grants of them on such a record were already refused. A direct grant of one on a parent entity of another type was accepted, and the permission walk carried it down onto every record of the shape's type beneath that parent.

- **The walk stops at the record.** When a check of a protected key walks up the parent edges, it still looks for a grant on a record of the protecting type, but it does not climb past it. A grant on the parent is still written and still applies to the parent itself, and to anything beneath the parent that the walk reaches without passing through such a record. Keys the shape does not protect walk as before. Role and node-level grants are not affected.
- **Existing grants are covered too.** The stop is applied when the check runs, so a grant on a parent made before this release, or before the scope recorded the shape, stops reaching the shape's records from the next check on. A vertical that relied on such a grant to reach a protected record has to give the shape on the record instead.
- **Capabilities and live roots walk the same way.** An `act` capability rooted above such a record no longer reaches it for a protected key. A live subscription whose root is checked by a protected key is nudged about a row beneath the root that the key reaches only through such a record only when the subscriber's own check of the key on that row allows it. A holder by a node-level grant or by the record's shape still is; a holder by a grant above the record no longer is. `reachesWithin` and `ancestorsWithin` take an optional key and stop where its check stops. Without a key they walk every edge, as a vouched root does.
- **Recorded as K-48**, the one exception to rule 3 of the permission algebra.
- `ScopeTupleReader` gains a required `shapeProtectedTypes(relation)`, which both adapters answer with the kernel's `shapeProtectedTypesQuery`. The explicit-grant refusal reads the same query. A check reads it at most once, and only when the walk is about to climb from an entity that has parent edges. A node-level check, a hit on the entity itself, and a miss on an entity with no parents read nothing extra.
