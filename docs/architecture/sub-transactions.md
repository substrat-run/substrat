---
status: built
layer: kernel
description: Sub-transactions at the engine seam: ctx.atomic.
---

# Sub-transactions at the engine seam — `ctx.atomic`

Status: **built** (v0.2 — shipped as `ctx.atomic` in `@substrat-run/kernel`, `runSub` in both
adapters, the atomic contract suite, and boundary-lint R7; #770, #786)

> Answers the five open questions in issue
> [#770](https://github.com/substrat-run/substrat/issues/770), which was raised out of
> [`docs/strategy/why-substrat.md` §7](../strategy/why-substrat.md) (the Convex comparison). Companion to
> [kernel-design.md](kernel-design.md) (the scope-host contract),
> [platform-neutral-surface.md](platform-neutral-surface.md) (the non-Cloudflare mapping)
> and [platform-intents.md](platform-intents.md) (one of the four things that must roll back).
>
> **The gap this closed.** A vertical composes engine in-scope functions inside **one** scope
> transaction. The adapter opens the transaction once per operation and rolls back only if
> the *handler* throws ([adapter-sqlite/src/index.ts:1858](../../packages/adapter-sqlite/src/index.ts#L1858)).
> There was no boundary at the engine call, so a vertical that caught an engine error was
> sitting on that engine's partial writes and committed them. The only correct advice was
> "never catch an engine error" — a convention, in a repo whose premise is that this
> category gets a mechanism.
>
> **v0.2** rewrote the adapter contract (§3) after taking a third adapter seriously. v0.1
> had each adapter implementing the semantics; that is the part that rots when someone
> writes a scope host over Postgres or Kubernetes.

## 0. What the spikes settled

Both runtimes were probed directly before any decision below was taken — the issue called
this "a scope-host contract question, not research", which is right, but only because the
primitives turned out to behave. One of them does not behave the way the issue assumed.

### SQLite (better-sqlite3 13.0.3), 4 probes

| Probe | Result |
|---|---|
| `SAVEPOINT` nested inside `BEGIN IMMEDIATE`, inner rolled back | inner writes gone, outer's survive, commits once |
| Two stacked savepoints, inner released, outer rolled back to | correct at both depths |
| Outer `ROLLBACK` after a savepoint was `RELEASE`d | **everything discarded** — a sub-transaction's commit is provisional |
| Constraint error *inside* the savepoint, then `ROLLBACK TO` | recovers; `inTransaction` still true; the operation continues and commits |

### Durable Objects (workerd, via `@cloudflare/vitest-pool-workers`), 7 probes

| Probe | Result |
|---|---|
| `SAVEPOINT` via `sql.exec` inside `storage.transaction()` | **forbidden by the runtime** |
| Nested `storage.transaction()`, inner throws | inner writes gone, outer continues and commits |
| Nested `storage.transaction()` with a **real `await`** before the throw | same — rollback survives the await |
| Two stacked sub-transactions, one failing and one succeeding | both correct |
| Outer throws after a sub-transaction succeeded | **everything discarded** — matches SQLite |
| `transactionSync` nested inside the async outer transaction | works, rolls back inner only |
| `await` after a nested `transactionSync`, then outer throws | outer rollback still discards everything |

The forbidden one is exact, and it is the correction the issue needs:

> To execute a transaction, please use the `state.storage.transaction()` or
> `state.storage.transactionSync()` APIs instead of the SQL `BEGIN TRANSACTION` or
> `SAVEPOINT` statements.

**So the two adapters can share a contract but never an implementation.** The issue's "SQLite
has `SAVEPOINT`, DO storage has nested transactions" is true as written, but they are not two
spellings of one mechanism: one is a SQL statement, the other is a runtime API that *forbids*
that statement. This is why the seam has to be a kernel verb rather than a helper emitting SQL
— and, in §3, why the adapter's half has the shape it does.

## 1. The third adapter changes the problem statement

Portability is a first-class claim: *"write a scope host over Postgres, or over your own
Kubernetes cluster … make `@substrat-run/contract-tests` pass, and your verticals run there
unchanged"* ([why-substrat.md](../strategy/why-substrat.md)), with the suite named as **the
specification of what an adapter must do**. Issue
[#123](https://github.com/substrat-run/substrat/issues/123) makes the Kubernetes path a
definition-of-done item.

Postgres breaks a symmetry the two current substrates happen to share. It puts a transaction
into `25P02 in_failed_sql_transaction` on **any** error — every subsequent statement fails
until `ROLLBACK` or `ROLLBACK TO SAVEPOINT`. (Stated from known Postgres behaviour, not
probed here, unlike everything in §0.) Contrast the last SQLite probe, where an ordinary
constraint violation left the transaction usable.

So *"catch an engine error and keep going"* had **three different meanings** across the
substrates we claim portability for:

| Substrate | What a caught engine error did before `ctx.atomic` |
|---|---|
| SQLite | silently commits the engine's partial writes — the #770 bug |
| Durable Objects | same class: the writes stay in the enclosing transaction |
| Postgres | the operation dies at the *next* statement, with an unrelated-looking error |

That makes this a **portability defect as much as a correctness one**, and nothing in the
contract suite pinned it — a Postgres adapter could pass the old suite and still differ here.
`ctx.atomic` is what gives "catch" one meaning on all three.

## 2. D-1 — the seam is an explicit `ctx.atomic(fn)` (question 1)

```ts
atomic<T>(fn: () => T | Promise<T>): Promise<T>;
```

Rolls back everything `fn` wrote if it throws, then **rethrows the original error**. Returns
`fn`'s value otherwise. Always a `Promise` — operations are already async, and the DO
adapter's nesting primitive is the async one.

Explicit, not implicit per-engine-function. The decisive argument is §1's:

**Implicit wrapping only makes one pattern safe** — catching around exactly one engine call.
A vertical that catches an error from *its own* code (a Zod parse, a constraint on its own
table) is, on Postgres, still holding a poisoned transaction with no savepoint to return to.
`ctx.atomic` is a general recoverable-region primitive; implicit engine wrapping is a special
case of it, and the general one is what a third adapter needs anyway.

Three supporting reasons:

1. **Implicit taxes reads for nothing.** Two of `engine-workorder`'s five in-scope exports
   are pure reads (`getReportedLines`, `listOrders`); `engine-protocol` has more.
2. **The per-call boundary is the wrong boundary.** A vertical composes *several* engine
   calls into one logical step — `demos/callout` does — and what it wants atomic is the
   composed step. Implicit cannot express that; explicit does, for free, by putting more
   than one call in the callback.
3. **Implicit would not remove the convention.** A per-call savepoint only helps someone who
   catches, and catching is exactly what CLAUDE.md forbids today. Implicit leaves the rule
   unchanged and adds cost.

There is also a hard constraint behind reason 3: **implicit is not implementable at the
seam.** An engine in-scope function is a plain TypeScript call (`createWorkOrder(ctx, …)`) —
deliberately, so a vertical extends by composition instead of forking. The runtime never sees
it happen. Implicit would require either every engine wrapping itself (a convention with a
different holder, equally un-lintable) or reifying the call — see §9.

**The issue's objection to explicit — "that is a convention again" — is answered by making it
lintable, which implicit never could be.** Shipped as `boundary-lint` **R7**
([#786](https://github.com/substrat-run/substrat/issues/786),
[boundary-lint/src/index.ts](../../packages/boundary-lint/src/index.ts)):

> In module code, a `catch` whose `try` block calls an imported engine in-scope function, and
> which is not lexically inside a `ctx.atomic` callback, is a violation.

That turns "never catch an engine error" from a sentence in a doc into a mechanical gate.
Sequenced after the mechanism, so the lint has something to point people at.

**It is R7, not the R6 this document proposed.** Rule numbers are claimed when they ship:
the no-clock rule ([#812](https://github.com/substrat-run/substrat/issues/812)) landed first
and took `R6`, so this one became `R7`. Two rules sharing a number would be worse than a
stale proposal. What it decided, of the questions #786 left open:

| Question | Decision |
|---|---|
| A TypeScript AST pass? | **No.** One offset-preserving mask of comments/strings/regexes, then brace matching, run only on files that import an engine. Putting `typescript` in `dependencies` would buy a type checker — ~20MB into every scaffolded vertical — to answer two questions a scanner answers exactly |
| `try`/`finally`, no `catch` | **Allowed** — it swallows nothing |
| A re-throwing `catch` | **Allowed** — the operation still fails and the whole transaction rolls back. Read as a rethrow when the catch's last top-level statement is a `throw`, wrapped or not. A throw inside an `if` **block** is not that, so `catch (e) { if (fatal(e)) { throw e } return null }` is still flagged |
| An escape hatch | **None.** Unlike R5's one-time handoff there is no legitimate unprotected swallow, so a hatch would only ever silence the rule |
| False positives | Under-fires on purpose, so a clean run is not a proof: an engine call moved into a local helper is invisible to it; the promise spelling (`engineCall(…).catch(…)`) is not the `catch` clause the rule names; and the *unbraced* `catch (e) { if (rare) throw e; }` sits at top level and reads as an always-rethrow. Widening is fixtures, not a redesign |

## 3. D-2 — one closure-shaped adapter method; the kernel owns every semantic

**This is the decision that a third adapter turns on**, and it is where v0.1 was wrong: it had
each adapter implementing the depth stack, the mark/restore of §4's in-memory state, and the
rethrow. Three adapters times that list means the third gets it subtly wrong — and §4.1's
failure mode is *silent*: a well-formed event carrying a wrong `authorization`, nothing thrown.

Everything except the storage primitive is substrate-independent, so it belongs in the kernel.
A scope host supplies exactly one method:

```ts
/** All a scope host supplies. No semantics — those are the kernel's. */
runSub<T>(depth: number, fn: () => Promise<T>): Promise<T>;
```

| Adapter | Implementation |
|---|---|
| `adapter-cloudflare` | `storage.transaction(fn)` — ignores `depth`; the runtime owns the stack |
| `adapter-sqlite` | `SAVEPOINT s{depth}` → `fn` → `RELEASE`, or `ROLLBACK TO` on throw |
| a Postgres / Kubernetes host | character-identical to `adapter-sqlite` |

**It must be closure-shaped, and that is the non-obvious part.** The natural design is
`enter` / `rollback` / `release`, and it cannot work: the DO API *is* a closure
(`storage.transaction(async () => …)`), and decomposing it into enter/exit would mean holding
a manually-resolved promise open across the runtime's I/O gates. A closure interface wraps
savepoints trivially; the reverse is not true. Design enter/exit now and the DO adapter fakes
it — and the third adapter inherits the fake.

The kernel then owns, once: the depth counter, the mark/restore in §4.3, rethrowing the
original error unwrapped, and the eventual return-validation hook (§9). A Kubernetes adapter
author writes three SQL statements and gets the rest by construction.

## 4. D-3 — three of the four side-effects roll back for free; two in-memory tallies do not (questions 2 and 3)

The issue lists `ctx.emit`, `ctx.link` and `ctx.requestPlatform` as things needing "the same
rollback point". Reading both adapters, they already have it — every one is a row write into
the scope's **own** database, inside the same transaction:

| Verb | Write | Dispatch |
|---|---|---|
| `ctx.emit` | `INSERT INTO _substrat_outbox` ([sqlite:6345](../../packages/adapter-sqlite/src/index.ts#L6345), [scope-do:1884](../../packages/adapter-cloudflare/src/scope-do.ts#L1884)) | strictly **after** commit ([sqlite:1868](../../packages/adapter-sqlite/src/index.ts#L1868)) |
| `ctx.requestPlatform` | `INSERT INTO _substrat_platform_requests` ([sqlite:6388](../../packages/adapter-sqlite/src/index.ts#L6388)) | pulled by the sweep, post-commit |
| `ctx.link` / `ctx.grant` | `INSERT OR IGNORE INTO _substrat_tuples` | n/a |
| `ctx.revoke` | `DELETE FROM _substrat_tuples` | n/a |

`runSub` discards all of them. Questions 2 and 3 therefore collapse from "design a mechanism"
to "**assert it in the contract test**". The permission checker holds no cache in either
adapter, so a rolled-back `grant` cannot survive in memory either.

**What does *not* roll back is the actual finding, and it is symmetric across both adapters** —
two pieces of per-invoke state living in JavaScript, not in the database.

### 4.1 `passed: EventAuthorization[]` — a spine-integrity defect

[adapter-sqlite:6285](../../packages/adapter-sqlite/src/index.ts#L6285) ·
[scope-do:1837](../../packages/adapter-cloudflare/src/scope-do.ts#L1837)

The K-34 accumulator of checks that passed during this operation; `ctx.emit` snapshots it onto
every event's `authorization` field. A check that passed **inside a rolled-back
sub-transaction stays in the array**, so a *later* event emitted by the caller carries an
authorization for work that never happened.

The audit spine would attribute a permission check to an event whose operation discarded the
thing that check authorized. Nothing throws, the event is well-formed, the record is wrong —
exactly the class the spine exists to prevent.

### 4.2 `signals.platformRequests` — an inflated drain kick

[adapter-sqlite:6399](../../packages/adapter-sqlite/src/index.ts#L6399) ·
[scope-do:1929](../../packages/adapter-cloudflare/src/scope-do.ts#L1929)

The #458 per-invoke tally that fires `onPlatformRequests`, which the router turns into an
immediate drain (#381). A rolled-back sub-transaction leaves it inflated, so a scope with zero
surviving intents still kicks a drain that finds nothing. Advisory only — a miss costs one
sweep interval — but `ScopeStubOptions` already promises it is "never fired for a rolled-back
operation", and that promise should hold at this boundary too.

### 4.3 The fix, and where it lives

Both are append-only during an operation, so rollback is a mark/restore, not a re-derive:
snapshot `passed.length` and the counter on entry; truncate/restore on rollback. Per §3 this
lives in the **kernel**, around `runSub` — not in either adapter, and not in the third one.

## 5. D-4 — nesting is a stack, and both runtimes already keep one (question 4)

- **DO**: `storage.transaction()` nests natively; the runtime owns the stack. Verified two
  deep, including a failing sibling beside a succeeding one.
- **SQLite / Postgres**: named savepoints by depth (`s0`, `s1`, …). Stacking verified.

Engine→engine calls stay forbidden (star topology, R1) — this is about a *vertical* wrapping
several engine calls, which is ordinary and now expressible. No depth cap is proposed; if one
is ever wanted it is a kernel constant, not a redesign.

The rule both runtimes independently confirm, and which the contract test must pin: **a
sub-transaction's commit is provisional.** If the operation later throws, the whole thing is
discarded, `atomic` or not. `ctx.atomic` narrows what a *caught* error destroys; it never
promotes writes past the operation's own commit.

## 6. D-5 — the contract test is the deliverable (question 5)

A new suite in `@substrat-run/contract-tests`, exported alongside the existing four and driven
from both adapters' existing entry points. **No adapter capability flag is needed** — both
runtimes were verified to support every assertion, which is the point of having probed first.

Because §3 puts the semantics in the kernel, the suite is really testing the kernel once, with
each adapter proving only that its `runSub` is a real transaction boundary. That is what keeps
the third adapter's job bounded.

One operation, one `ctx.atomic` whose callee throws, asserting:

- [x] the callee's **rows** are gone
- [x] the callee's **events** are gone — no `_substrat_outbox` row, and no consumer ran
- [x] the callee's **links and grants** are gone
- [x] the callee's **platform intents** are gone
- [x] the caller's writes **before and after** the atomic survive
- [x] it all commits **once**
- [x] the **original error** reaches the caller's `catch`, unwrapped
- [x] a check that passed inside the rolled-back callee does **not** appear in a later event's
      `authorization` (§4.1)
- [ ] `onPlatformRequests` does not fire for intents that only existed inside the rollback (§4.2)
      — the kernel restores the tally (`sub-transaction.ts`), but the suite does not yet
      assert the signal itself
- [x] **stacked**: one atomic fails, a sibling succeeds — both land correctly
- [x] **provisional commit**: the operation throws after a *successful* atomic → the atomic's
      writes are discarded too
- [x] **the caller's own error is recoverable too** — catching a non-engine error raised inside
      an atomic leaves the transaction usable (§1: the assertion a Postgres host must satisfy,
      and the one the old suite could not express)

## 7. D-6 — what a vertical may then assume

The engine-composition section of [CLAUDE.md](../../CLAUDE.md) used to imply the "never
catch" convention. It now says:

> An engine call may be wrapped in `await ctx.atomic(() => …)`. If it throws, everything that
> call wrote — rows, events, links, grants, platform intents — is gone, the vertical's own
> writes survive, and it all commits once. Outside `ctx.atomic`, catching an engine error is
> still forbidden, and boundary-lint R7 rejects it.

## 8. Cost, and one honest caveat

**Cost.** One savepoint per `atomic` on SQLite/Postgres; one nested `storage.transaction` on
DO. Paid only where written — the whole argument for explicit in §2.

**Caveat.** `ROLLBACK TO` recovers from ordinary constraint violations (verified), but a few
SQLite conditions abort the enclosing transaction outright regardless — `SQLITE_FULL`,
`SQLITE_BUSY`, `SQLITE_NOMEM`, and an explicit `ON CONFLICT ROLLBACK`. So `ctx.atomic`
guarantees *the callee's writes are discarded and the caller's survive*; it does **not**
guarantee the enclosing operation survives an arbitrary storage-level failure. Stated where
the guarantee is documented, rather than discovered at 3am.

## 9. Deliberately deferred — the reified engine call

The long-term fork is not explicit-versus-implicit; it is whether the engine seam ever becomes
**reified** — `ctx.call(workorder.create, input)`, the Convex shape. Convex can wrap component
calls implicitly precisely because they go through its runtime; ours is a plain function call,
and the runtime cannot see it (§2).

The one scenario that would force reification is **engines running out-of-process**, which is
plausibly what a mature Kubernetes deployment eventually wants — a plain function call cannot
be made remote; a reified one can.

Not now: it is unconsumed generality by the master plan's own §3 test, and it costs the
composition property that keeps engines un-forked. But it is worth recording that `ctx.atomic`
is the **no-regret** move — if `ctx.call` is ever built it uses this same machinery
internally, whereas implicit-per-engine-function is the option that would have to be unwound.

Two adjacent things land on this seam if it exists:

- **[#771](https://github.com/substrat-run/substrat/issues/771)** (validate engine return
  values) is the *same boundary*, filed from the same Convex comparison. `atomic` is where a
  returned value crosses back, so it gives #771 a seam to live in instead of a per-engine habit.
- Engine-version telemetry ([#114](https://github.com/substrat-run/substrat/issues/114)) would
  have one place to observe rather than none.

## 10. Sequencing — all done

1. Kernel: `atomic` on `OperationContext`, the depth stack, the §4.3 mark/restore, and the
   `runSub` scope-host method.
2. Contract-tests: the suite in §6 (fails against both adapters).
3. `adapter-sqlite`: `runSub` via savepoints.
4. `adapter-cloudflare`: `runSub` via nested `storage.transaction`.
5. CLAUDE.md §engine-composition (§7), and the caveat in §8.
6. **Separately, after the above**: boundary-lint R7 (§2) — done, #786.
