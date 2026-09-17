# 4. What a handler can and cannot do

We left the last chapter one step from the handler. This chapter is that step: what an
operation is handed, what it is denied, and why each denial is worth its inconvenience.

## The whole surface

An operation handler receives exactly one thing.

```ts
async function createWorkOrder(ctx: OperationContext, input: CreateInput) {
  assertAllowed(await ctx.check('workorder:create'));

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
| `ctx.tenantId` / `scopeId` / `principal` | where this runs and on whose behalf, read-only |
| `ctx.sql` | `query` / `exec` against **this scope's** database |
| `ctx.now()` | the operation's instant, and the only clock |
| `ctx.check(perm, entity?)` | a permission decision |
| `ctx.emit(event)` | a domain event, into the outbox |
| `ctx.page(entityType, params)` | one page of a declared list: filters, sort, keyset cursor, total |
| `ctx.search(entityType, term)` | full-text lookup over declared searchable fields |
| `ctx.versionOf(entity)` | an entity's current version, for `If-Match` preconditions |
| `ctx.link(child, parent)` | a permanent entity relationship |
| `ctx.grant` / `ctx.revoke` | user-initiated per-entity sharing |
| `ctx.canAssign(roleKey)` | whether the caller holds everything a role would confer |
| `ctx.atomic(fn)` | a sub-transaction |
| `ctx.entitlement(key)` / `entitlements()` | the tenant's plan, quota and expiry for a module it holds |
| `ctx.requestPlatform(req)` | ask the platform for a privileged effect |
| `ctx.platformRequests(filter)` | read back what the platform did with those |
| `ctx.sealToConnection(provider, value)` | encrypt a value so only that connector can open it |

**Nothing on `ctx` checks a permission except `ctx.check`.** `page`, `search` and `versionOf`
read data, and the operation's own `assertAllowed` comes first, as always.

A connector's handler gets a *different* context with a scoped `connection(provider)` handle.
That handle is host code's, not an operation's, and it appears later in this chapter.

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
whose target is a `_substrat_*` table is refused, on both adapters.

Those tables are **the spine**: the kernel's own tables, created in every scope database next
to your module's. The outbox and the delivery journal (chapter 5), the denial log, the
platform-intent queue, the permission tuples and their projections (chapter 6), the migration
journal, schedule state, attachments and idempotency records all live there. The directory has a
spine of its own, holding the admin log, the access log, identities and entitlements. Only the
kernel writes the spine. Forging a row in it is forging the audit trail or the permission model. This is a mechanism rather than a lint
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

## SQL strings, and why there is no query builder

`ctx.sql` takes a SQL string and a parameter array. There is no ORM, no query builder, and no
typed query layer generated from the model. The model emits tables, migrations, an API
description and a browser client, but not queries.

That can look like an omission. It is a choice, and the reasoning is worth checking against your
own threat model, because the protections are real and so is one gap.

**What a query builder would buy, and where you already have it.** Builders earn their keep in
three places: preventing injection, composing dynamic filters, and hiding dialect differences.
Here:

- **Binding is positional.** `ctx.sql.query('SELECT … WHERE id = ?', [id])` sends the value as a
  bound parameter, never as SQL text. That is the same protection a builder gives, provided
  values go in the array.
- **Dynamic reads are kernel-composed.** A list with user-chosen filters, sort and cursor is
  `ctx.page`, which builds the `WHERE`, `ORDER BY`, keyset comparison and `LIMIT` from what the
  operation *declared* filterable and sortable, and refuses anything else by name. The query that
  most tempts people to concatenate strings is the one you do not write.
- **There is one dialect.** Both adapters are SQLite, so there is no dialect to hide.

**Why injection is survivable when it happens.** Everything else here is defence in depth, and
it is deep:

- **Inputs are parsed before the handler runs** (below). An `id` declared as a ULID cannot arrive
  as `1 OR 1=1`.
- **The database holds one scope.** An injected statement runs against a database containing that
  scope's rows and nothing else. It cannot read another tenant, because there is no other tenant
  in the file (chapter 2).
- **The spine refuses writes regardless of where the SQL came from.** The spine-write check
  parses every statement in the string, including stacked ones, so an injected
  `; INSERT INTO _substrat_tuples …` is refused like a hand-written one.

**The gap, stated.** Nothing mechanical stops a handler from writing
`` `… WHERE name = '${input.name}'` ``. No lint rule inspects SQL strings for interpolation.
Engines interpolate constant column lists on purpose, which is why a crude rule would drown in
false positives. So "values go in the array" is a review convention, not a mechanism. And on the
local SQLite adapter, statements that reach past the scope's own file, such as `ATTACH`, are not
refused by the kernel. The spine check deliberately leaves them to the runtime, and on Durable
Objects the runtime restricts them. On self-hosted SQLite, an injected `ATTACH` is the one path
from a scope's SQL to another file on the same disk.

Why plain SQL at all: a migration is a human checkpoint, and SQL is what a reviewer can read.
A query in a diff is a query, not a builder chain whose SQL you have to imagine.

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
the contract on SQLite only, and so is facet *recency* — that a bucket's `lastSeen` is its
latest event, which the wall clock cannot tell from its first. Those are the two suites the
two adapters do not share, for that one reason, and it is written down rather than quietly
tolerated.

Code that must read the real clock — a JWT whose `exp` a remote server judges — opts out
with a reviewable `boundary-lint-allow R6` block.

### Timestamps are text, and a fixed width of it

Timestamps are stored as **ISO 8601 text**, never epoch integers. `ctx.now()` returns an
`Instant`, and every `Instant` is normalized to UTC in exactly one shape:
`2026-09-17T08:41:05.123Z`. Offsets are converted and precision is fixed at milliseconds, so every
value is exactly 24 characters.

The reasons, in order of how much they matter:

- **Comparison is lexicographic, and correct.** Grant liveness is `expires_at > ?`, a metering
  close horizon is a string comparison, and `ORDER BY occurred_at` sorts. Text sorts
  chronologically only when every value shares a zone and a shape, and the normalization
  guarantees that. An offset timestamp compared as text against a `Z` timestamp is simply wrong,
  which is why the parser rewrites rather than accepts.
- **No unit convention.** An integer column cannot say whether it holds seconds or milliseconds,
  and a system with many modules eventually has both.
- **It reads correctly in a `.sqlite` file someone opens by hand**, in an exported dump, and in an
  event payload. The row and the event announcing it hold the identical string.

A fair worry about text is that values change size on update, which in some storage engines
means rows move and pages fragment. It does not apply here, for two reasons. First, the
normalization makes every instant the same length, so updating `2026-09-17T08:41:05.123Z` to a
later instant rewrites 24 bytes with 24 bytes. The row does not grow. (Moving a column from
`NULL` to a value grows a row whatever its type.) Second, SQLite has no append-only heap and no
MVCC row versions. An update rewrites the record inside its B-tree page, and space freed inside
a page is reused by that page.

The real cost is width. SQLite stores an epoch integer in 4 bytes as seconds or 6 as
milliseconds, so 24 bytes is four to six times as much per timestamp column. It is a real cost, it is small next to a row's other text,
and it buys comparisons that cannot silently go wrong.

For dates without a time, such as a birthday or a leave day, the contract is `calendarDate`,
`YYYY-MM-DD`, which sorts the same way.

## `ctx.check` — first line, every time

Every operation's first line is a permission check:

```ts
assertAllowed(await ctx.check('workorder:create'));
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

There is no `fetch` in module code. None. Boundary-lint rule R3 refuses it, along with any HTTP
client import.

Effects on the outside world are somebody else's job. There are three mechanisms, and all three
share one shape: **the module writes a durable row in its own transaction, and something outside
the transaction acts on it afterwards.**

- **An executor** is a handler the *host* registers against an event type. It runs after the
  commit, outside the scope, with platform authority (`HostAdmin`) instead of a `ctx`. It is the
  shape for effects that are not scope-local, such as writing tenant-wide directory state,
  because a module cannot write to another database inside its own transaction without leaving
  an orphan on rollback.
- **A connector** is an executor that is also handed a per-tenant credential and permission to
  call one provider over the network, and nothing more. Signing, accounting and planning
  integrations are connectors. A connector is host code, never module code.
- **A platform intent** (`ctx.requestPlatform`) is how a sandbox-clean vertical asks for a
  privileged action it has no authority to perform itself. The intent is a durable row written
  atomically with your operation. The platform pulls and executes it later, and
  `ctx.platformRequests()` reads back what happened, including a failure, so a screen can say
  "this did not go out" instead of showing something that only appears to have.

All three are chapter 5.

## What an `await` holds

Handlers are `async`, so a fair question is what happens while one waits. Does a slow
operation block other requests on its scope, or on every scope?

**Its own scope only.** Chapter 2's queue gives each scope one turn at a time, and the turn
lasts from the moment the operation starts until its post-commit work is done. On Durable
Objects, post-commit work includes draining in-scope consumers (chapter 5). So an operation that
takes two seconds, or a consumer that takes two seconds, delays the *next operation on that
scope* by two seconds.

Everything else runs on:

- **Other scopes** are other Durable Objects, or other actors on the local adapter, each with
  its own queue. A slow scope costs nobody else anything.
- **The vertical's worker is not serialized.** Requests to it run concurrently. Only the hop
  into a scope waits its turn.
- **Executors and connectors on Durable Objects run on the coordinator**, after the scope's turn
  has ended. A slow provider delays that HTTP response and holds no scope's queue. (On the local
  SQLite adapter they currently run inside the scope's turn. That is a real difference between
  the two hosts, and it only shows up under a slow connector.)

In practice a handler has almost nothing slow to wait on, and that is the ban on the network
working as designed. `ctx.check`, `ctx.entitlement` and `ctx.canAssign` read scope-local
projections (chapter 6). `sealToConnection` is local Web Crypto. Nothing on `ctx` crosses a
network on the normal path, so the queue drains quickly *because* module code cannot reach
anything slow. Nothing in the kernel times an operation out, either. The platform's own limits
are the only ceiling.

### When the work genuinely takes time

Some work is slow by nature: calling a language model, rendering a document, waiting on a
provider. The pattern is to **keep the slow part out of the operation and bracket it with
operations**:

```ts
// in the vertical's worker (harness code, not module code)
const context = await stub.invoke('desk/prepare-answer', { conversationId });  // fast: read + record intent
const answer  = await models.answer(context);                                  // slow: no scope turn held
await stub.invoke('desk/record-answer', { conversationId, answer });           // fast: write + meter + emit
```

The model call holds no transaction and no queue turn. Each operation around it is short,
checks its own permission, and commits on its own. The reference support-desk vertical answers
questions exactly this way, with the whole sequence handed to `waitUntil` so the user's
request returns first. If the work must survive the isolate going away, make the first
operation record that it is pending, so a sweep or the next request can find unfinished work.

The other option is to make the slow part an effect: emit an event, and let a connector do it
with retries (chapter 5). Pick by one question: does the vertical need the result *inside*
its own logic (bracket it), or is the result a side effect in someone else's system (emit
it)?

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
| bound parameters, `ctx.page` for dynamic reads | injection, and filters nobody declared |
| no `cloudflare:workers` | one import, every secret and every scope |
| no spine writes | a forged audit trail |
| `ctx.now()` only | rows disagreeing about when; untestable time logic |
| normalized ISO text | timestamps that compare wrongly |
| no network in handlers | a slow provider holding a scope's queue |
| check first, always | the guard that was never written |
| kernel-stamped envelopes | an event that lies about who did it |
| `ctx.atomic` to catch | committing an engine's half-finished state |
| host-side input parse | a declared schema nobody applied |

None of these is enforced by asking nicely. Most are linted, several are runtime
mechanisms, and the ones that are only conventions are named as such in
[Agent rules](/guide/agent-rules) rather than allowed to look enforced.

---

**Next:** [The life of one event →](/book/05-one-event)
