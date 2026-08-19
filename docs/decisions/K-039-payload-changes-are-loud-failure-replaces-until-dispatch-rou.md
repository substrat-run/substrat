---
id: K-39
date: 2026-08-19
layer: kernel
title: "Payload changes are loud-failure replaces; dual-emit is unavailable, not merely awkward"
status: accepted
aliases: []
amends: [D-28]
tracking: ["#128"]
---

# K-39 — Payload changes are loud-failure replaces; dual-emit is unavailable, not merely awkward

**Narrows D-28's evolution rule, and postpones the fix deliberately** (open question 16;
[#128](https://github.com/substrat-run/substrat/issues/128)). D-28 says a real change to a
shipped event payload means a `schemaVersion` bump plus **dual-emit through a deprecation
window**. The platform cannot execute that clause: consumer dispatch selects `WHERE o.type = ?`
with no version predicate, a manifest's `consumes` entry carries a `schemaVersion` that
registration discards, and the consumer registry has no version dimension. Both adapters
agree, so it is the contract rather than an adapter quirk. Dual-emitting v1 and v2 therefore
delivers **both** events to the same consumer — for `invoicing.underlag-exported`, whose
consumer is by design an accounting connector, a double invoice, silently, in production.
So the clause is narrowed rather than left standing: **until dispatch routes on
`(type, schemaVersion)`, a payload change is a REPLACE, and dual-emit is not an available
option.** A replace fails loudly — a v1 consumer's strict parse rejects v2 and dead-letters,
which someone sees — where dual-emit fails silently and expensively. Everything else in D-28
is untouched: payload fields stay frozen once shipped, new operation inputs stay
optional-with-behavior-preserving-default, permission keys are never renamed. **Routable
dispatch is wanted and is explicitly postponed**, not abandoned; #128 holds the scope, and
this entry exists so the interval is governed rather than latent.

## Why

The dangerous state was not the missing feature — it was the **disagreement between a
written rule and the executable behaviour**, because a rule that reads as available is one
somebody follows. `engine-invoicing` already shipped its v2 bump as a replace on exactly
this reasoning, so this entry records what the code does instead of leaving the log
asserting the opposite. Open question 16's own words were *"the current state — a decision
the platform cannot execute — is the one option that should not survive review"*; narrowing
the clause is the cheapest way to end that state without building the fix.

**The cost is real and is the reason this is a narrowing rather than a resolution.** A
replace breaks every v1 consumer at once, loudly, with no migration window — which is
tolerable while the only consumers are ours and intolerable once they are not. All seven
engines are live on public npm, so the condition open question 16 set for itself (*"decide
before a third party consumes an engine event"*) is already met; what this buys is a
governed interval, not more runway. Two things follow for whoever picks up #128: the fix is
`(type, schemaVersion)` in the dispatch predicate plus a version dimension on the registry,
and the deadline has passed rather than approaching.
