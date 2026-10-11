---
id: K-48
date: 2026-10-11
layer: kernel
title: "A key a declared shape protects reaches a record of the shape's type only through the record"
status: accepted
aliases: []
amends: [K-12]
tracking: ["#2177"]
---

# K-48 — A key a declared shape protects reaches a record of the shape's type only through the record

**Rule 3 of the derivation algebra gains one exception.** Entity-narrowed grants still flow down manifest-declared parent edges, depth-capped. But a walk for a key that a declared entity-grant shape protects (a `'grantee'` shape's keys, or a binding shape's) probes a record of the shape's type and does not climb past it. A grant of that key on an ancestor therefore reaches neither the record nor anything beneath it through the record. It still reaches the ancestor itself, and anything beneath the ancestor by a path that passes through no such record. Every other key walks exactly as before. Rules 1, 2 and 4 are unchanged, and so are node-level grants, which are evaluated before the walk.

**This is not negation.** No tuple denies anything, and the cut is not authored by a vertical. It is a fact the kernel records at reconcile: the scope's `shape:<type>` rows, the same ones the explicit writer reads. The algebra stays fixed and still has no rewrites. A walk for a protected key just has one more place where it ends.

**One rule, every walk that carries a key.** `check` and an `act` capability's walk to its root stop at the same place, through one predicate. A live subscription whose root is checked by a key walks to the root with that stop as well. A row beneath the root that the key reaches only through such a record is decided by the subscriber's own check of the key on the row. So a holder by a node-level grant, or by the record's own shape, is still told about it, and a holder by a grant above the record is not: the answer `check` gives. A walk with no key, such as a vouched live root, walks every edge as before.

## Cost

A check reads the protecting types at most once per walk, and only when it is about to climb from an entity that has parent edges. A node-level check, a hit on the entity itself, and a miss on an entity with no parents read nothing extra.

## Behaviour change, stated

A grant of a protected key on an ancestor, made before this change or before the scope recorded the shape, stops reaching the shape's records from the next check on. No vertical in the repository declares a parent above a protected type.

## Why

As an entity-narrowed grant, a protected key is given on a record of the shape's type only by the shape's own grant (#2083, #1686); a role or a scope-level grant holds it at the node, as every key is held. The explicit writer refuses it on such a record. That is what "a portal record's people are exactly its holders" and "on a binding record only the column decides" rest on. The walk carried a grant on any ancestor down onto every such record beneath it, so the refusal could be bypassed by granting one level up.

**At the walk, not at the writer.** A write-time refusal on "types declared above the shape's type" cannot be made sound. The walk follows live parent edges whose relation is no longer declared, and a relation declared in a later release would turn an already-accepted grant into a leak. Such a refusal would also leave grants already on the spine untouched. Refusing the key on every entity would forbid ordinary sharing: a customer shape that protects `workorder:read` would forbid sharing one work order. The cut at the walk holds whenever a grant was written, and leaves every other path alone.
