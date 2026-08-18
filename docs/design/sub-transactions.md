# Sub-transactions at the engine seam — `ctx.atomic`

Status: draft v0.1 · Last updated: 2026-08-19

> Answers the five open questions in issue
> [#770](https://github.com/substrat-run/substrat/issues/770), which was raised out of
> [`docs/why-substrat.md` §7](../why-substrat.md) (the Convex comparison). Companion to
> [kernel-design.md](kernel-design.md) (the scope-host contract) and
> [platform-intents.md](platform-intents.md) (one of the four things that must roll back).
>
> **The gap, restated.** A vertical composes engine in-scope functions inside **one** scope
> transaction. The adapter opens the transaction once per operation and rolls back only if
> the *handler* throws ([adapter-sqlite/src/index.ts:1858](../../packages/adapter-sqlite/src/index.ts#L1858)).
> There is no boundary at the engine call, so a vertical that catches an engine error is
> sitting on that engine's partial writes and commits them. The only correct advice today is
> "never catch an engine error" — a convention, in a repo whose premise is that this
> category gets a mechanism.

## 0. What the spikes settled

Both runtimes were probed directly before any of the decisions below were taken — the issue
called this "a scope-host contract question, not research", and that is right, but only
because the primitives turned out to behave. One of them does not behave the way the issue
assumed.

### SQLite (better-sqlite3 13.0.3), 4 probes

| Probe | Result |
|---|---|
| `SAVEPOINT` nested inside `BEGIN IMMEDIATE`, inner rolled back | inner writes gone, outer's survive, commits once |
| Two stacked savepoints, inner released, outer rolled back to | correct at both depths |
| Outer `ROLLBACK` after a savepoint was `RELEASE`d | **everything discarded** — a sub-transaction's commit is provisional |
| Constraint error *inside* the savepoint, then `ROLLBACK TO` | recovers; `inTransaction` still true; the operation continues and commits |

The last one is the load-bearing one: SQLite does **not** abort the enclosing transaction on
an ordinary constraint violation, so `ROLLBACK TO` genuinely recovers.

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

**So the two adapters cannot share an implementation — only a contract.** The issue's "SQLite
has `SAVEPOINT`, DO storage has nested transactions" is true as written, but they are not two
spellings of one mechanism: one is a SQL statement, the other is a runtime API that
*forbids* that statement. This is why the seam has to be a kernel verb rather than a helper
that emits SQL.

## 1. D-1 — the seam is an explicit `ctx.atomic(fn)` (question 1)

```ts
atomic<T>(fn: () => T | Promise<T>): Promise<T>;
```

Rolls back everything `fn` wrote if it throws, then **rethrows the original error**. Returns
`fn`'s value otherwise. Always a `Promise` — operations are already async, and the DO
adapter's nesting primitive is the async one.

Explicit, not implicit-per-engine-function, for three reasons:

1. **Implicit taxes reads for nothing.** Of `engine-workorder`'s five in-scope exports, two
   are pure reads (`getReportedLines`, `listOrders`); `engine-protocol` has more. Wrapping
   every call means a savepoint on every read.
2. **The per-call boundary is the wrong boundary.** A vertical composes *several* engine
   calls into one logical step — `demos/callout` does — and what it wants atomic is the
   composed step, not each call. Implicit wrapping cannot express that; explicit does, for
   free, by putting more than one call inside the callback.
3. **Implicit does not remove the convention.** A per-call savepoint is only *useful* to
   someone who catches, and catching is exactly what CLAUDE.md forbids today. Implicit
   would leave the rule unchanged and add cost. Explicit is what lets the rule change.

**The issue's objection to explicit — "that is a convention again" — is answered by making it
lintable, which implicit never could be.** Proposed as `boundary-lint` **R6** (the rules are
`R1`–`R5` today, [boundary-lint/src/index.ts:52](../../packages/boundary-lint/src/index.ts#L52)):

> In module code, a `catch` whose `try` block calls an imported engine in-scope function, and
> which is not lexically inside a `ctx.atomic` callback, is a violation.

That converts "never catch an engine error" from a sentence in a doc into a mechanical gate —
the repo's actual standard. Sequenced after the mechanism lands, so the lint has something to
point people at.

## 2. D-2 — three of the four side-effects roll back for free; two in-memory tallies do not (questions 2 and 3)

The issue lists `ctx.emit`, `ctx.link` and `ctx.requestPlatform` as things needing "the same
rollback point". Reading both adapters, they already have it. Every one is a row write into
the scope's **own** database, inside the same transaction:

| Verb | Write | Dispatch |
|---|---|---|
| `ctx.emit` | `INSERT INTO _substrat_outbox` ([sqlite:6345](../../packages/adapter-sqlite/src/index.ts#L6345), [scope-do:1884](../../packages/adapter-cloudflare/src/scope-do.ts#L1884)) | strictly **after** commit ([sqlite:1868](../../packages/adapter-sqlite/src/index.ts#L1868)) |
| `ctx.requestPlatform` | `INSERT INTO _substrat_platform_requests` ([sqlite:6388](../../packages/adapter-sqlite/src/index.ts#L6388)) | pulled by the sweep, post-commit |
| `ctx.link` / `ctx.grant` | `INSERT OR IGNORE INTO _substrat_tuples` | n/a |
| `ctx.revoke` | `DELETE FROM _substrat_tuples` | n/a |

A savepoint (SQLite) or a nested `storage.transaction` (DO) discards all of them. Questions 2
and 3 therefore collapse from "design a mechanism" to "**assert it in the contract test**".
The permission checker holds no cache in either adapter, so a rolled-back `grant` cannot
survive in memory either.

**What does *not* roll back is the actual finding, and it is symmetric across both adapters** —
two pieces of per-invoke state that live in JavaScript, not in SQLite:

### 2.1 `passed: EventAuthorization[]` — a spine-integrity defect

[adapter-sqlite:6285](../../packages/adapter-sqlite/src/index.ts#L6285) ·
[scope-do:1837](../../packages/adapter-cloudflare/src/scope-do.ts#L1837)

The K-34 accumulator of checks that passed during this operation; `ctx.emit` snapshots it onto
every event's `authorization` field. A check that passed **inside a rolled-back
sub-transaction stays in the array**, so a *later* event emitted by the caller carries an
authorization for work that never happened.

That is the sharp one: the audit spine would attribute a permission check to an event whose
operation discarded the thing that check authorized. It is silent — nothing throws, the event
is well-formed, and the record is wrong. Exactly the class the spine exists to prevent.

### 2.2 `signals.platformRequests` — an inflated drain kick

[adapter-sqlite:6399](../../packages/adapter-sqlite/src/index.ts#L6399) ·
[scope-do:1929](../../packages/adapter-cloudflare/src/scope-do.ts#L1929)

The #458 per-invoke tally that fires `onPlatformRequests`, which the router turns into an
immediate drain (#381). A rolled-back sub-transaction leaves it inflated, so a scope with zero
surviving intents still kicks a drain that finds nothing. Advisory only — the documented cost
of a miss is one sweep interval — but `ScopeStubOptions` already promises it is
"never fired for a rolled-back operation", and that promise should hold at this boundary too.

### 2.3 The fix

Both are append-only during an operation, so the rollback is a mark/restore, not a re-derive:
snapshot `passed.length` and the counter when entering `atomic`, truncate/restore on rollback.
It belongs in the same helper as the savepoint, in both adapters, and it is a handful of lines
in each.

## 3. D-3 — nesting is a stack, and both runtimes already keep one (question 4)

- **SQLite**: named savepoints by depth (`sp0`, `sp1`, …). Stacking verified.
- **DO**: `storage.transaction()` nests natively; the runtime owns the stack. Verified two
  deep, including a failing sibling next to a succeeding one.

Engine→engine calls stay forbidden (star topology, R1) — this is about a *vertical* wrapping
several engine calls, which is ordinary and now expressible. No depth cap is proposed; if one
is ever wanted it is a kernel constant, not a redesign.

The rule both runtimes independently confirm, and which the contract test must pin: **a
sub-transaction's commit is provisional.** If the operation later throws, the whole thing is
discarded, `atomic` or not. `ctx.atomic` narrows what a *caught* error destroys; it never
promotes writes past the operation's own commit.

## 4. D-4 — the contract test is the deliverable (question 5)

A new suite in `@substrat-run/contract-tests`, exported alongside the existing four and driven
from both adapters' existing entry points. **No adapter capability flag is needed** — both
runtimes were verified to support every assertion, which is the point of having probed first.

One operation, one `ctx.atomic` whose callee throws, asserting:

- [ ] the callee's **rows** are gone
- [ ] the callee's **events** are gone — no `_substrat_outbox` row, and no consumer ran
- [ ] the callee's **links and grants** are gone
- [ ] the callee's **platform intents** are gone
- [ ] the caller's writes **before and after** the atomic survive
- [ ] it all commits **once**
- [ ] the **original error** reaches the caller's `catch` (not a wrapper)
- [ ] a check that passed inside the rolled-back callee does **not** appear in a later event's
      `authorization` (§2.1)
- [ ] `onPlatformRequests` does not fire for intents that only existed inside the rollback (§2.2)
- [ ] **stacked**: one atomic fails, a sibling succeeds — both land correctly
- [ ] **provisional commit**: the operation throws after a *successful* atomic → the atomic's
      writes are discarded too

## 5. D-5 — what a vertical may then assume

The engine-composition section of [CLAUDE.md](../../CLAUDE.md) currently implies the "never
catch" convention. It becomes:

> An engine call may be wrapped in `await ctx.atomic(() => …)`. If it throws, everything that
> call wrote — rows, events, links, grants, platform intents — is gone, the vertical's own
> writes survive, and it all commits once. Outside `ctx.atomic`, catching an engine error is
> still forbidden, and boundary-lint R6 rejects it.

## 6. Cost, and one honest caveat

**Cost.** One savepoint per `atomic` on SQLite; one nested `storage.transaction` on DO. Paid
only where written — which is the whole argument for explicit in §1.

**Caveat.** `ROLLBACK TO` recovers from ordinary constraint violations (verified), but a few
SQLite conditions abort the enclosing transaction outright regardless — `SQLITE_FULL`,
`SQLITE_BUSY`, `SQLITE_NOMEM`, and an explicit `ON CONFLICT ROLLBACK`. So `ctx.atomic`
guarantees *the callee's writes are discarded and the caller's survive*; it does **not**
guarantee the enclosing operation survives an arbitrary storage-level failure. Worth stating
where the guarantee is documented, rather than discovering it at 3am.

## 7. Sequencing

1. Kernel: `atomic` on `OperationContext` + the mark/restore helper shape.
2. Contract-tests: the suite in §4 (fails against both adapters).
3. `adapter-sqlite`: savepoints by depth + mark/restore.
4. `adapter-cloudflare`: nested `storage.transaction` + mark/restore.
5. CLAUDE.md §engine-composition (§5), and the caveat in §6.
6. **Separately, after the above**: boundary-lint R6.
