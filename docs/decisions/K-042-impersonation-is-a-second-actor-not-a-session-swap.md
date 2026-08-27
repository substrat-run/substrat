---
id: K-42
date: 2026-08-27
layer: kernel
title: "Impersonation is a second actor, not a session swap"
status: accepted
aliases: []
tracking: ["#868", "#85", "#44"]
---

# K-42 — Impersonation is a second actor, not a session swap

**Acting as a principal is a fourth scope door (`getImpersonatedScope`) whose invocation carries TWO actors: permissions resolve as the impersonated principal, and every record keeps the staff actor who was really at the keyboard.** The session is a kernel-stamped `Impersonation` — actor, principal, reason, window, `readOnly` — minted by `stampImpersonation` and readable by module code as `ctx.impersonation`, never settable by it: the K-34 argument applied a second time, and it gives the same answer, because a record module code can suppress is not evidence. The spine gains an `impersonation` column beside K-34's `authorization`, in both adapters, so a mutation's `actor` stays the principal it acted AS while the column says who was behind it. Four properties bound it: **read-only by default** (`writes: true` is an explicit opt-in — the refusals live on `ctx.emit`/`requestPlatform`/`grant`/`revoke`/`link`, with an always-rollback backstop under them for a handler that writes without emitting); **time-boxed**, checked on every invoke rather than once at the door, because a stub is an object a caller can hold; **reason-carrying and required**, riding into the admin log and onto every event; and **announced before it exists** — the `impersonate` admin-log entry is written before the stub is returned, K-33's failure ordering.

## Why

### The version everyone else ships is the one that fails an audit

Supporting a customer's live vertical meant asking for screenshots, and the reason is not that impersonation is hard — it is that the obvious implementation is a **session swap**: exchange the staff session for the customer's and let everything downstream work unchanged. It works, it is two hours of work, and it destroys the only fact an incident review needs. The audit trail then says a customer approved an invoice that a support engineer approved. No later log can recover it, because the information was never written: this is the same append-only, cheap-now/impossible-later shape that justified shipping K-34's column before its consumer existed.

The expensive half was already built. Per-person platform actors (K-20), the envelope's kernel-stamped authorization (K-34), the append-only admin log and K-24's access log all existed; what was missing was a seam, not a mechanism. That is why this is a door and a column rather than a subsystem.

### Whose permissions, and why not the intersection

[#868](https://github.com/substrat-run/substrat/issues/868) proposed intersecting the impersonated principal's permissions with the staff actor's, as the conservative answer that survives *"our support engineer approved an invoice"*. It does not survive contact with the model. A `PlatformActorId` is deliberately **not** a `PrincipalId` (K-20 branded them apart precisely so a staff actor cannot be mistaken for a person in a tenant), and it holds no tuples in a tenant's scope — so the intersection is empty, always, and the feature would be permanently useless. Worse, the fix for that would be to mint scope principals for staff, which is the attribution laundering [#97](https://github.com/substrat-run/substrat/issues/97) already refused for connectors.

So permissions resolve as the impersonated principal, wholly. What the intersection was reaching for is delivered by `readOnly` instead, and delivered absolutely rather than by set arithmetic: the support engineer cannot approve the invoice because **nothing in the session can write**, not because a permission happened to be missing from one side of an intersection. The contract suite pins this from both directions — a session acting as a reader is refused a permission it lacks, and the same staff actor acting as an admin passes the same check.

### Read-only by default, with the backstop stated

The issue's fourth question — writes at all, or read-only first — is answered *both*, in the only order that is safe: read-only unless the opener explicitly asked otherwise. `writes: true` on the request becomes `readOnly: false` on the record, and the inversion is the point: an absent field means the safe thing on both sides, which is the only arrangement where forgetting it is harmless.

Enforcement is two layers, and the second is the authoritative one — the same arrangement `assertReadOnlyQuery` already uses in front of the SQL console, adopted here for the same reason. The first layer refuses the mutating verbs on `ctx`, which is a **complete** gate for any conforming module, since D-5 requires every mutation to emit. It is also the layer that fails *loudly*: telling a support engineer their fix landed when the transaction was silently discarded is worse than either refusing or allowing. The second layer is that a read-only invocation never commits at all, which is what covers the handler that writes through `ctx.sql.exec` and emits nothing — a rule violation nothing mechanically prevents, and the only path from a support read into a customer's table. The suite tests that path with a deliberately non-conforming fixture, because a backstop tested only against conforming code has not been tested.

The two adapters reach it by different mechanisms and that asymmetry is itself worth recording: the pure adapter issues `ROLLBACK` where it would have issued `COMMIT`; workerd's `ctx.storage.transaction` has no such verb, so the DO discards the invocation by failing the transaction with a module-private sentinel. Same guarantee, two spellings, one shared suite — which is what the suite is for.

### The window is checked per invoke, and measured in seconds

A stub is an ordinary JavaScript object a console can hold for as long as it likes, so a check at mint time bounds nothing: the session would live until the process restarted. `assertImpersonationLive` therefore runs at the top of every invoke, ahead of the unknown-operation check so an expired session cannot even enumerate what exists. The bound is exclusive, which matters more than it looks — `ctx.now()` is stable for a whole invocation ([#812](https://github.com/substrat-run/substrat/issues/812)), so an inclusive bound would admit an entire operation that began exactly at expiry.

`ttlSeconds` rather than `ttlMinutes` is a testability decision stated rather than hidden. The pure host takes an injectable `clock` and can be driven past an expiry instantly; the ScopeDO is constructed by workerd and has no such seam, so the only way to prove on the deployed adapter that a session actually dies is to ask for one short enough to outlive in a test. A contract that can only be verified on one of two adapters is half a contract.
