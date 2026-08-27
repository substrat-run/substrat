---
id: K-42
date: 2026-08-26
layer: kernel
title: "An impersonated operation carries two actors, and the permission model answers as the impersonated one"
status: accepted
aliases: []
amends: []
tracking: ["#868", "#85", "#44"]
---

# K-42 — An impersonated operation carries two actors, and the permission model answers as the impersonated one

**Support acts AS a principal through a fourth scope door, and every record the scope writes about who did what keeps both the impersonated principal and the staff actor who was really there.** The permission model answers about the impersonated principal — through the ordinary `PermissionChecker`, with no override branch anywhere, exactly as `system:<moduleId>` became a subject rather than a bypass (#383) — so a session against a principal who holds nothing is refused precisely where that principal would be. The second actor rides as a kernel-stamped `impersonation` on the outbox envelope, the K-35 denial row and the platform-intent journal, on K-34's pattern and for K-34's reason: it is absent from `DomainEventInput`, so module code can neither claim a session nor drop one. It is also absent from `ctx`, which is the addition K-34 did not need — a vertical that could *read* the session could branch on it, and "hide this row when support is looking" is the one behaviour the feature must make impossible. A session is opened through `HostAdmin.beginImpersonation` (audited **before** it is usable), is time-boxed (`IMPERSONATION_MAX_MINUTES`, re-read on **every** invoke rather than once at the door), carries a required reason, and is **`read-only` unless somebody asked for otherwise** — enforced by rolling the transaction back rather than committing it, not by the effecting verbs alone.

## Why

### The expensive half was already built, so this is a seam

Per-person platform actors (K-20), an envelope that records what authorized it (K-34), an append-only admin log, and an access log for staff reads (K-24) were all shipped. What was missing was the ability to act as somebody — and the only impersonation in the tree was the `ALLOW_DEV_HEADER` dev bypass, correctly labelled *"never a production path"*. Supporting a customer's live vertical therefore meant asking them to screenshot things. Every platform grows this surface eventually; the version that grows by itself is a session swap that loses the real actor, which is precisely the version that fails an audit. Building it before five customer projects exist is the only reason to do it now.

### Intersection was the conservative answer to the wrong question

#868 asked whether an impersonated session gets the impersonated principal's permissions or **the intersection with the staff actor's**, and named intersection as the answer that survives *"our support engineer approved an invoice"*. Building it showed the intersection is EMPTY, always: a `PlatformActorId` is branded apart from a `PrincipalId` precisely so a staff member is not a person in any tenant, and it holds no scope permissions at all. An intersection would make every session useless, and the obvious repair — inventing a scope role for staff — is the session swap wearing a different hat.

So the bound moved from the permission set to the **mode**. `read-only` is the default, and it answers #868's last open question (*"writes at all, or read-only first?"*) the same way: most of the debugging value at a fraction of the argument. What it buys, that an intersection would not have, is that the restriction is legible in the session record itself — a reviewer reads `mode: 'read-only'` and a reason, rather than reconstructing which grants two actors had in common at a moment that has since passed.

### Read-only had to be a mechanism, not a promise

The obvious implementation refuses `ctx.emit`, `ctx.requestPlatform`, `ctx.grant`, `ctx.revoke` and `ctx.link`. It is also insufficient, and quietly so: most of what a handler does is `ctx.sql.exec`, which goes through none of them. An adapter that stopped at the verbs would pass every plausible test and commit the row.

So the transaction is **rolled back rather than committed** — the pure adapter issues `ROLLBACK`, the DO throws a sentinel out of `ctx.storage.transaction`, which is the identical mechanism the scope console already uses for read-only SQL (`queryScope`). The verbs still refuse by name, because that is the half a support engineer *sees*: a write that silently vanished is worse than one that was refused. The contract suite's load-bearing case is therefore the one whose handler calls no effecting verb at all.

Two consequences worth stating rather than discovering. The operation still **runs and still answers** — its return value survives the rollback, which is what makes "see what they see" work at all. And the post-commit drain is skipped, because a session that may not have side effects must not run consumers as one.

### Checked per invoke, because a stub is a capability

A session validated only at the door is a time box that expires for everyone except the one caller holding a stub — and `endImpersonation` would stop nothing. So the session is re-read from the directory on every invoke. On the pure adapter that is a local read; on Cloudflare it is a coordinator-side directory read whose result is passed **whole** to the ScopeDO rather than as an id, because a DO that resolved a session id itself would be trusting a value the RPC caller chose.

That last hop is the one place this feature could fail OPEN, and it is the reason the DO's reply carries an `impersonation.honoured` acknowledgement on the model of #129's `ifMatchChecked`. Every other argument ever added to that RPC has been safe for an older DO to ignore; this one is not — it would run the operation as the impersonated principal with nothing stamped and no read-only bound, which is a support session that reads as recorded and is not. The coordinator refuses the success rather than accepting an unrecorded one.

### The admin entry precedes the session

K-33 chose failure ordering so every partial state is visible, and the same argument decides this: the admin-log row is written before `beginImpersonation` returns, so by the time a stub can exist there is already a durable record of who acquired the ability to act as whom, and why. The reason lives in that row rather than only in the session store, because a log saying a session opened but not why is the half an incident review does not need. Sessions are never deleted (K-21's tombstone rule) — a session that once existed is why some rows carry the stamp they do — and an expired session is deliberately a different fact from an ended one: one ran out, the other was stopped by a person.

### What this does not do

The scope's own reads are unchanged: an impersonated read is not itself written to the K-24 access log, because that log is the DIRECTORY's and a scope read has never been in it. `listImpersonations` is, like every other staff read. There is no HTTP surface here and no console screen — this is the kernel seam, and the control-plane route and the "you are viewing as…" banner are the next issue's work, not this one's. Nothing in the tree opens a session automatically; the only way to get one is for a named staff actor to ask for one, with a reason, through `HostAdmin`.
