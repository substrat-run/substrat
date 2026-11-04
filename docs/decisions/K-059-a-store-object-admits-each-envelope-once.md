---
id: K-59
date: 2026-11-04
layer: kernel
title: "A store object admits each envelope once"
status: proposed
aliases: []
amends: ["K-52"]
tracking: ["#2830"]
---

# K-59 — A store object admits each envelope once

> **Proposed 2026-11-04.** It amends one sentence of [K-52](./K-052-the-scope-store-envelope-is-ed25519-per-audience-and-an-object-is-bound-to-its-name-by-its-id.md), "a store remembers no nonces", and answers the scope-stores RFC's Q2 the other way. Everything else in K-52 stands.

**A store object spends the nonce of every envelope it admits, and refuses the same envelope again.** The check runs in the platform's store entry, in the object, after the envelope has verified and the object's id has matched the signed name, and before the driver is reached. The refusal is `401 unauthorized: nonce`, outside the store envelope, like the entry's other refusals. The nonces live in the object's own synchronous KV storage (`ctx.storage.kv`, which a SQLite-backed object has), under the `substrat.store-nonce/` prefix, keyed by the issue time and the nonce. They are not in a SQL table, so they are none of the tables a driver creates, exports or wipes by name. A key is kept while its envelope is fresh, and the freshness check refuses a replay after that by itself, so the key is forgotten then: a bounded batch of expired keys per call. The entry judges freshness again at the clock it forgets by, so a key is never forgotten while its envelope would still be admitted. One function does it, `spendStoreNonce` in `store-entry/verify.ts`, and both entries call it: the JavaScript entry directly, the Python entry through the verifier module it already imports.

Neither signer re-sends an envelope: the router and the control plane sign each call they send. So no caller changes.

What this does not cover. The nonces are in the same storage the driver's class has, so they are held apart from a driver by the review of its release, as the rest of the object's storage is (D-63). A wipe that clears the object's storage forgets them too. Moving the check where the driver's code cannot reach it is part of [#2830](https://github.com/substrat-run/substrat/issues/2830).

## Why

K-52 left nonces unremembered because the reserved operations are idempotent, a driver call is a vertical's retry that the window bounds, and remembering costs a write on every call (the RFC's Q2). The first written-outside driver changes the weight of that answer. Its operations are not all idempotent, and a store call passes through the driver's own script on the way in, so an envelope that can be admitted twice inside its window is something a release's review has to rule out by reading. Spending the nonce makes that a property of the platform's entry instead, for one small synchronous write per admitted call. It is the same rule the platform already keeps for a signed call that changes a vertical's state ([K-58](./K-058-a-call-from-the-platform-to-a-vertical-carries-an-ed25519-envelope-and-a-deployed-vertical-holds-public-keys-only.md)).
