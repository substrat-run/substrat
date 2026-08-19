---
id: K-34
date: 2026-07-28
layer: kernel
title: "The event envelope records what authorized it"
status: accepted
aliases: []
tracking: []
---
# K-34 — The event envelope records what authorized it

**The event envelope records what authorized it** (extends §6.1/D-5; powers control-plane.md §4.5's runtime permission story; plan decision 39 is the sibling). `ctx.check` computes a `Decision` whose allow branch carries the proof chain (§4.2) — and until now the operation consumed it and the kernel discarded it, so a mutation-event records who acted but never under what authority. The envelope gains an optional, kernel-stamped `authorization`: the permission key(s) the emitting operation checked-and-passed, plus — when the allow resolved through a capability grant rather than a role — the granting tuple's `object` (**the shape correction that survived contact with the data: there is no grant *id*.** A grant is a relation tuple `(subject, granted:<perm>, object)` with no surrogate key, so what names *which* grant is that `object` — the entity or node it was granted on; a role expansion's terminal tuple has a `role:<key>` subject and yields no ref). Stamped kernel-side like tenant/scope/actor — module code can neither supply it (it is not on `DomainEventInput`) nor suppress it; a system/override actor is unconditionally allowed, so its checks are not authorizations and are not recorded. Implemented in **both** adapters (the pure-SQLite outbox column and the DO port), with the operation context built fresh per invoke so the accumulator cannot leak across operations. The full proof chain is NOT persisted: chains embed tuple rows (principal/org identifiers — a PII and size concern in a log drained to Tier 2), and `explain` re-derives chains on demand; what re-derivation cannot recover is which permission and grant were *actually consulted at write time* once tuples have since changed — that pointer is exactly what is kept. Additive: optional field, no schemaVersion bump, honestly absent on all historical events

## Why

The spine is append-only and K-4's argument runs in reverse on it: authorization not captured at emit time is unrecoverable, so every day without the field is history permanently lost — the cheap-now/impossible-later shape that justifies shipping the column before its consumer exists (K-24's `drained_at` precedent). "Under what grant did this write happen?" is the first question a permission incident asks, and today no log answers it: the admin log holds permission *changes*, the access log staff *reads*, the outbox the mutation without its authority. Keeping key + grant ref rather than the chain is the same discipline as K-24's bounded parameter summaries: pointers into evidence, not payload dumps
