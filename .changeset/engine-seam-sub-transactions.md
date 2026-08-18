---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

`ctx.atomic` — engine calls can now be sub-transactions, so catching one is safe (#770).

A vertical composes engine in-scope functions inside ONE scope transaction, and the adapter
rolled back only when the whole handler threw. So a vertical that did the reasonable thing —
catch a `completeWorkOrder` failure, fall back to a manual path — was sitting on the engine's
partial writes and committed them. Those are precisely the rows the engine's invariants exist
to protect, which makes it the one place partial state is least acceptable. The only correct
advice was "never catch an engine error": a convention, in the one category this platform
normally answers with a mechanism.

```ts
try {
  await ctx.atomic(() => completeWorkOrder(ctx, { orderId, billable }));
} catch {
  // the engine's rows, events, links, grants and platform intents are all gone;
  // your own writes survive, and it still commits once
}
```

**Every semantic lives in the kernel.** A scope host supplies one method — `runSub(depth, fn)`
— and `createAtomic` owns the depth stack, the interleaving guard, the unwrapped rethrow, and
the restore of two tallies the storage rollback cannot reach. That split is for the third
adapter: a Postgres or Kubernetes host writes three SQL statements and inherits the rest.
`runSub` is closure-shaped because the Durable Object primitive *is* a closure and forbids
`SAVEPOINT` outright — the two hosts share a contract, never an implementation.

The subtle half is what does not roll back on its own. The K-34 `passed` accumulator lives in
JavaScript, so a check that passed inside a discarded region would have ridden out on the next
event — the audit spine attributing a permission check to an event whose operation threw that
work away, with nothing raised and the event well-formed. The #458 platform-request tally
leaked the same way and kicked a drain for intents that never survived. Both are restored now.

Also a portability fix. "Catch an engine error and keep going" meant three different things
across the substrates this project claims: SQLite committed the partial writes, the DO host did
the same, and Postgres poisons the transaction outright (`25P02`) so the operation dies at the
next statement. `ctx.atomic` gives it one meaning, and `@substrat-run/contract-tests` now ships
`atomicContractSuite` — twelve cases both adapters pass unchanged, including the Postgres-shaped
one (a caught *storage* error leaves the transaction usable) that no existing suite could express.

Design note: `docs/design/sub-transactions.md`.
