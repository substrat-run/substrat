---
id: K-35
date: 2026-07-28
layer: kernel
title: "Permission denials are recorded in a scope-local denial log, never the admin log"
status: accepted
aliases: []
tracking: ["#867"]
---
# K-35 — Permission denials are recorded in a scope-local denial log, never the admin log

> **The tail is built (#867, 2026-08-24).** This decision's last clause ends "the
> directory-side surfacing of these scope-local rows rides §5.4's admin-query RPC,
> unbuilt" — for four weeks both adapters wrote the log and nothing read it. `HostAdmin`
> now carries `listDenials` and `summarizeDenials`, reached through the same delegation
> ladder as the table reads (a hosted scope through its vertical, a co-located one
> locally), surfaced per scope in the console. Both of the hedges this decision named as
> sanctionable were built rather than deferred: the bucketed view is ordered by COUNT so a
> prober's volume cannot push a quiet actor off the page, and the window's own floor is
> reported unfiltered so an empty result cannot be read as "never happened" when the truth
> is that the rows drained. The decision text below is unchanged.

**Permission denials are recorded in a scope-local denial log, never the admin log** (sibling of K-24's access log; control-plane.md §4.6). `assertAllowed` throws `PermissionDenied` and nothing recorded it — a refused call left no row in any log, so "who has been probing for access they don't hold" was unanswerable. The shape that survived contact with the code: **the denial happens in the scope's serialization domain, and a denial rolls its own operation back** — so it cannot be written to the directory access log (a different DO/DB, unreachable inside a scope transaction) and, written in the operation's transaction, would be erased by the rollback it is evidence of. So it lands in a **scope-local `_substrat_denials`** (actor, permission, node, operation, at, drained_at), recorded at the operation boundary the moment a `PermissionDenied` unwinds it — a fresh autocommit write, AFTER the rollback, so it survives. Only an *enforced* denial (`assertAllowed`, which attaches the checked key + node) records; a bare `ctx.check` a module branches on (list filtering) is not a denial, and a module's own hand-thrown `PermissionDenied('…')` carries no checked key — that is the module's policy, not the permission model's — so both are deliberately silent. `PermissionDenied`'s message constructor stays the public surface (modules throw it directly), which is exactly why the checked key rides an optional detail rather than a required constructor arg. NOT the admin log: a denial is attacker-influenceable volume (a probing client mints unlimited rows) and operational history, not permanent evidence — precisely K-24's retention split, so it `drains rather than expires` and rate-bucketing (first occurrence + count per actor/key/window) stays sanctionable. Implemented in both adapters; the directory-side surfacing of these scope-local rows rides §5.4's admin-query RPC, unbuilt

## Why

The asymmetry being corrected: the platform logs every staff *read* (K-24) but no *refusal*, though a denial carries more signal per row than any read — it is the one event where an actor's intent and the permission model visibly disagree. Success-path-only logging was never a decision; it was an accident of `recordAccess`/`recordAdmin` running after the mutation succeeds. The volume argument that kept reads out of the admin log applies doubly to denials and answers *where* they go, not *whether*
