# 4. What a handler can and cannot do

We left the last chapter one step from the handler. This chapter is that step: what an
operation is handed, what it is denied, and why each denial is worth its inconvenience.

## The whole surface

An operation handler receives exactly one thing.

```ts
async function createWorkOrder(ctx: OperationContext, input: CreateInput) {
  assertAllowed(await ctx.check('workorder.create'));

  const id = ulid();
  ctx.sql.exec(
    'INSERT INTO wo_orders (id, title, state, created_at) VALUES (?, ?, ?, ?)',
    [id, input.title, 'scheduled', ctx.now()],
  );
  ctx.emit({
    type: 'workorder.created',
    entity: { entityType: 'workorder', entityId: id },
    piiClass: 'none',
    payload: { id, title: input.title },
  });
  return { id };
}
```

That is representative, not simplified. `ctx` is the entire capability surface:

| | |
|---|---|
| `ctx.sql` | `query` / `exec` against **this scope's** database |
| `ctx.now()` | the operation's instant — the only clock |
| `ctx.check(perm, entity?)` | a permission decision |
| `ctx.emit(event)` | a domain event, into the outbox |
| `ctx.link(child, parent)` | a permanent entity relationship |
| `ctx.grant` / `ctx.revoke` | user-initiated per-entity sharing |
| `ctx.atomic(fn)` | a sub-transaction |
| `ctx.entitlement(key)` | the tenant's plan for a module it holds |
| `ctx.requestPlatform(req)` | ask the platform for a privileged effect |
| `ctx.platformRequests(filter)` | read back what the platform did with those |
| `ctx.connection(provider)` | a scoped handle on a connector connection |

There is no `env`. No `fetch`. No database handle. No `process`. No import of anything
that could provide one. Capabilities come from `ctx` and from nowhere else, and that is
the single sentence the rest of this chapter unpacks.

## `ctx.sql` — and why it is the only way in

`ctx.sql` is already inside one scope's database. It has no parameter for tenant or scope
because there is nothing else it could address.

Module code may not import `better-sqlite3`, an adapter, `node:*`, or `cloudflare:workers`.
Most of those bans are obvious portability hygiene. **`cloudflare:workers` is not, and it
is the sharpest one.** That module exports an ambient `env`. One import hands module code
every binding and secret the script declares — including its own `SCOPE` Durable Object
namespace, which reaches *another scope's data*, precisely where `ctx.sql` cannot. It is a
single import that dissolves the isolation the whole architecture is built on, and it
looks completely innocuous in a diff.

The linter refuses it (`node tools/boundary-lint.mjs`, rule R2), and harness code —
`seed.ts`, `server.ts`, tests — is exempt because it is not module code.

One rule inside `ctx.sql` is enforced by the **runtime**, not only the linter: a write
whose target is a `_substrat_*` table is refused, on both adapters. Those are the kernel's
spine — the outbox, the delivery journal, the denial log, the platform-intent queue — and
forging a row in one is forging the audit trail. This is a mechanism rather than a lint
rule because the linter does not run on the hosted push path, and a guarantee that holds
only where CI happens to look is not a guarantee. Only the write's *target* is judged, so
`INSERT INTO my_timeline SELECT … FROM _substrat_outbox` is fine.

Reading the spine **is** sanctioned, and there are helpers for it — use them:
`readTimeline` and `readHistory` from `@substrat-run/kernel` take an `EntityRef`, page
like an ordinary list read, and decode the envelope. `readHistory` additionally returns
the payload, the authorization chain, the impersonation stamp, the PII class, the emitting
operation and the version the emitting code was deployed as. On most of those a `null` is
a *fact* — the payload was erased, nobody was impersonating, a consumer emitted it — which
a hand-rolled `SELECT` would read as missing data instead. Neither helper checks a
permission; the caller does that first, as always.

## `ctx.now()` — the only clock

`new Date()` and `Date.now()` are boundary-lint violations (R6), the same class of ban as
`node:*`.

Two reasons, and the second is the one that bites. First, **stability**: `ctx.now()`
returns the same instant for the whole invocation, stamped when the context was built. Two
rows written in one transaction cannot disagree about when they were written, and an event
cannot disagree with the row it describes. Second, **testability**: anything genuinely
time-dependent — an absence window, a metering period, a booking hold, a grant expiry — is
untestable against the wall clock except by sleeping or by shrinking the window to zero,
both of which produce tests that assert less than they appear to.

The pure host takes a `clock`, so a scenario uses `manualClock` or `frozenClock` and
asserts an elapsed-time transition directly. The Durable-Object host declares
`clock?: never` and means it: the reads that matter happen inside the ScopeDO that workerd
constructs, which a host option cannot reach. So grant *expiry transitions* are held to
the contract on SQLite only — that is the one suite the two adapters do not share, and it
is written down rather than quietly tolerated.

Code that must read the real clock — a JWT whose `exp` a remote server judges — opts out
with a reviewable `boundary-lint-allow R6` block.

Timestamps are stored as **ISO 8601 text**, never epoch integers.

## `ctx.check` — first line, every time

Every operation's first line is a permission check:

```ts
assertAllowed(await ctx.check('workorder.create'));
```

Not "usually". The reason to make it unconditional is that the alternative is a judgement
call at every handler, and judgement calls are where the missing check comes from six
months later.

Portal-style walks — "which of these can this person see?" — use the entity-scoped form,
`ctx.check(perm, entityRef)`, per row. Chapter 6 is how those are answered without a
network call.

A refused check throws `PermissionDenied`, the transaction rolls back, and the denial is
then written **outside** that transaction so it survives. You get a queryable record of
what was refused, to whom, on which operation, under which impersonation session — which
is the data you want when a customer says "it says I can't" and you need to know which
permission key to look at.

## `ctx.emit` — and the envelope you do not control

A mutation emits an event. The kernel stamps the envelope: id, occurred-at, tenant, scope,
actor, authorization chain, impersonation, the emitting operation, the deployed version.
The module supplies the type, the entity, the PII class and the payload — and the payload
is validated.

You cannot suppress the stamp, forge an actor, or emit on another scope's behalf, because
`emit` is below the API surface rather than beside it. That is what makes the event stream
an audit log *by construction* instead of by discipline.

Two rules about payloads matter enough to state here, and chapter 5 explains them:

- **Events are fat.** The payload carries everything a consumer needs, so the consumer
  snapshots rather than joins. A consumer that has to read back across a module boundary
  to interpret an event is an event that was emitted too thin.
- **PII classification is mandatory.** Not defaulted — declared. It is what makes erasure
  a query rather than an audit.

## `ctx.atomic` — the only way to catch an engine error

This one is a real trap, and it has a mechanism behind it.

An engine call composed inside your transaction has **no boundary of its own**. So a bare
`catch` around it leaves you holding its partial writes — the rows its invariants were
protecting — and then commits them:

```ts
// WRONG — boundary-lint R7 rejects this
try {
  await completeWorkOrder(ctx, { orderId, billable });
} catch {
  // the engine's half-written rows are still here, and will commit
}
```

The correct shape gives the engine call a boundary:

```ts
try {
  await ctx.atomic(() => completeWorkOrder(ctx, { orderId, billable }));
} catch {
  // the engine's rows, events, links, grants and platform intents are all gone;
  // your own writes survive, and it still commits once
}
```

A succeeded `atomic` is still **provisional** — if the operation later throws, its writes
go with everything else. Sub-transactions nest but must not interleave; starting two
concurrently throws.

Outside `ctx.atomic`, catching an engine error is forbidden and **R7 rejects it with no
escape hatch** — unlike R5, R6 and R8, which all have reviewable `boundary-lint-allow`
blocks. There is no legitimate reason to swallow an engine error unprotected.
`try`/`finally` with no `catch` is fine, and so is a catch that always rethrows: the
operation still fails and the whole transaction still rolls back.

## What is not here: the network

There is no `fetch` in module code. None.

Effects on the outside world are somebody else's job, and there are three somebody-elses,
each with a different reason:

- **Connectors** talk to third-party providers. They are host code, not module code.
- **Executors** effect things that are not scope-local — writing tenant-wide directory
  state, for instance — because a module cannot write to another database inside its own
  transaction without creating an orphan on rollback.
- **Platform intents** (`ctx.requestPlatform`) are how a sandbox-clean vertical asks for a
  privileged action without ever holding privilege. The intent is a durable row written
  atomically with your operation; the platform pulls and executes it later, and
  `ctx.platformRequests()` reads back what happened — including the failure, so a screen
  can say "this did not go out" instead of showing something that appears to have.

All three are chapter 5.

## Parse, don't trust — and the host is what parses

Operation inputs go through Zod schemas at the boundary, and **the host applies them**.

A module passes `operationInputs: operationInputsOf(ops)` beside its `operations`, and
every invocation is parsed before the guards and before the handler, on every path in —
HTTP, test, seed, schedule. Handlers do not hand-parse.

The distinction is not stylistic. If parsing were the handler's job, a declared input that
nobody validated would be an ordinary oversight. Because it is the host's job, it is not
possible.

## Why all of it is worth the inconvenience

Each rule in this chapter closes a specific failure that is otherwise silent:

| Rule | The failure it closes |
|---|---|
| `ctx.sql` only | reading another tenant |
| no `cloudflare:workers` | one import, every secret and every scope |
| no spine writes | a forged audit trail |
| `ctx.now()` only | rows disagreeing about when; untestable time logic |
| check first, always | the guard that was never written |
| kernel-stamped envelopes | an event that lies about who did it |
| `ctx.atomic` to catch | committing an engine's half-finished state |
| host-side input parse | a declared schema nobody applied |

None of these is enforced by asking nicely. Most are linted, several are runtime
mechanisms, and the ones that are only conventions are named as such in
[Agent rules](/guide/agent-rules) rather than allowed to look enforced.

---

**Next:** [The life of one event →](/book/05-one-event)
