# 5. The life of one event

This is the chapter the reference genuinely does not have. Every fact in it is published
somewhere — [Events & audit](/concepts/events) has the semantics, the adapter pages have
the machinery, [Modules & the manifest](/concepts/modules) has the declarations — but no
page walks the loop, so here it is, from `ctx.emit` to the consumer's commit, including
every way it can fail.

## Emit is a write, not a send

```ts
ctx.emit({
  type: 'workorder.completed',
  entity: { entityType: 'workorder', entityId: id },
  piiClass: 'none',
  payload: { id, lines, total },
});
```

Nothing is sent. `emit` writes a row into `_substrat_outbox`, **inside the operation's
transaction**, and returns.

That is the whole foundation of the design. The event and the domain write commit together
or not at all. There is no window in which the row exists and the event does not, and none
in which an event announces a row that rolled back. No two-phase commit, no coordinator,
no reconciliation job to find the mismatches — because the mismatch is not representable.

The envelope is stamped kernel-side. The module supplies four things (type, entity, PII
class, payload); the kernel supplies the id (a ULID, which is monotonic, so `ORDER BY id`
is creation order), the instant — the *operation's* instant, so every event one operation
emits carries the identical one — the tenant, the scope, the actor, the authorization
chain, the impersonation session if there was one, the operation name, and the version the
emitting code was deployed as.

### Fat payloads, and why

A consumer must never need a cross-module read to interpret an event. So the payload
carries everything: the billable lines, the prices, the totals — not an id to go look up.

The consumer therefore **snapshots** rather than joins, and prices are frozen at the moment
the event happened. Which is exactly what an invoice wants, and it stops being a stylistic
preference the moment you notice the alternative: a consumer that reads back into the
producer's tables is a consumer that breaks when the producer's schema moves, and that
reads *today's* price for *last month's* work.

And the consumer validates with **its own Zod parse**, never the producer's types. Importing
a producer's type would make the contract a compile-time coupling; parsing the payload
makes it a runtime contract, which is the only kind that survives two modules being on
different versions.

### PII classification is mandatory

`piiClass` is declared, not defaulted. It is what makes erasure a query rather than an
audit: when a subject invokes a right to erasure, the payloads that must be cleared are
the ones the class names, and the envelope — who did what, when — survives, because the
envelope is the compliance record.

## Post-commit: the consumer loop

The transaction commits. Immediately after, still inside the same invocation, the scope
drains its outbox:

```ts
// scope-do.ts, the tail of invoke()
if (!replayed) await this.dispatch(tenantId, scopeId);
```

`dispatch` is small enough to describe exactly. It runs **up to 50 rounds**. Each round
walks every registered module, and for each of that module's consumers, selects the outbox
rows of the matching type that have **no row in `_substrat_deliveries`** for that
`(event, module)` pair, oldest first.

For each such event:

```ts
await this.ctx.storage.transaction(async () => {
  const ctx = this.operationContext(systemPrincipal, tenantId, scopeId, { system: mod.id });
  await consumer.handler(ctx, event);
  this.sql.exec(
    `INSERT INTO _substrat_deliveries (event_id, consumer_module, delivered_at)
     VALUES (?, ?, ?)`,
    event.id, mod.id, new Date().toISOString(),
  );
});
```

Three things are load-bearing here.

**Each delivery is its own transaction.** The consumer's writes and the journal row marking
it delivered commit together. So a crash between the handler finishing and the journal being
written cannot exist — either both happened or neither did. Delivery is exactly-once with
respect to the journal, and at-least-once with respect to the world.

**The consumer runs as a system actor.** Its context carries `{ system: '@substrat-run/engine-invoicing' }`,
and that is what the audit trail shows for anything it writes. It is an ordinary in-scope
operation in every other respect — same `ctx`, same rules, same transaction semantics, same
inability to reach another scope.

**The loop rounds because consumers emit.** A consumer's own `ctx.emit` writes another
outbox row, which the next round picks up. Fifty rounds is the cascade limit, and the loop
exits as soon as a round delivers nothing.

### When a consumer throws

This is the part worth reading twice, because it is not what most queue-shaped systems do.

```ts
} catch (err) {
  // Dead-letter (v0): journal the failure so one poison event
  // can't wedge the loop. Written outside the rolled-back txn.
  this.sql.exec(
    `INSERT INTO _substrat_deliveries (event_id, consumer_module, delivered_at, error)
     VALUES (?, ?, ?, ?)`,
    event.id, mod.id, new Date().toISOString(), String(err),
  );
}
```

The consumer's transaction rolls back — none of its writes survive — and a journal row is
written **with the error**, outside that rolled-back transaction, so it persists.

**In-scope consumers do not retry.** One failure is terminal for that `(event, consumer)`
pair. The next round's query excludes the event because a delivery row now exists, so the
loop cannot wedge on a poison event, and the failure is evidence rather than a silent drop.

That is a deliberate v0 choice and the code says so. It is the right default for a consumer
that is pure in-scope logic — such a consumer fails because of a bug or bad data, and
retrying a bug five times produces five identical failures and a delay. It is the wrong
default if you were expecting queue semantics, so: **a failed in-scope consumer needs a
human or a replay, not a wait.**

Effects that genuinely need retrying are not in-scope consumers. They are executors, and
they work differently.

### Ordering

Guaranteed within one `(scope, module)` pair, and not across them. Within a pair, the
`ORDER BY o.id` on a monotonic ULID mint means creation order.

## The connector seam: executors

Some effects are not scope-local. Adding someone to an organization writes tenant-wide
directory state, outside any one scope's transaction. Sending mail leaves the building
entirely. A consumer cannot do either, because a consumer runs *inside* the scope and can
only touch that scope's data.

So a module **asks**, and an **executor** effects:

```
module (in-scope)                        executor (out-of-band)
  ctx.emit('member.add-requested')  ──▶    admin.addMember(...)
  commits WITH the domain write            writes the audit row
```

```ts
host.registerExecutor('member-adder', 'member.add-requested', async (admin, event) => {
  // receives HostAdmin, not ctx — it acts with platform authority,
  // which is exactly what module code must never hold
});
```

Why not write directly from the module? Because that would be a write to another database
inside a scope transaction: two independent commits, no coordinator, and an orphaned
membership if the scope rolls back after the directory write lands.

The event has no such hazard, because it enters the outbox in the **same transaction** as
the domain write. A rollback leaves no event and therefore nothing to effect.

### Executors retry, and the ordering is the point

An executor runs on the **coordinator**, not in the DO — it acts through `HostAdmin`, which
is outside the scope entirely. So the drain is a read inside the DO, the effect happens
outside, and the journal is written afterwards:

```sql
SELECT o.* FROM _substrat_outbox o
LEFT JOIN _substrat_deliveries d
  ON d.event_id = o.id AND d.consumer_module = ?
WHERE o.type = ?
  AND (d.event_id IS NULL
       OR (d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= ?))
ORDER BY o.id
```

"Due" means never attempted, or retrying and now past its next attempt time. Terminal rows
— delivered, or dead-lettered with `next_attempt_at IS NULL` — are excluded by the join.

The journal is written **after** the effect, on purpose. Claiming a delivery before running
it would make delivery at-most-once and lose the effect on any crash in between. Writing
afterwards means a crash mid-effect retries — which is why executors, like consumers, must
be idempotent, with the event id as the idempotency key.

Retry policy is **per executor**, not a host-wide constant, because the right answer differs:

| | default |
|---|---|
| `maxAttempts` | 5, including the first; reaching it dead-letters |
| `baseDelayMs` | 1000ms, doubling per attempt |
| `maxDelayMs` | 300000ms (5 minutes) — the ceiling on the doubling |

with jitter of ±20% on each computed delay. Those defaults suit a directory write. A
connector making an outbound HTTP call wants a longer tail, and sets one.

A failed attempt with **no next attempt time** is a dead letter — the row keeps the last
error, and the drain report counts it. `ExecutorDrainReport` returns `attempted`,
`delivered`, `retrying` and `deadLettered`, and those last two are the numbers a health
surface reports. A caller that ignores them learns nothing, which is exactly the failure
mode the older silent path had.

### Who actually retries

Dispatch is **prompt**: the drain runs inline, in the request that emitted the event, so
the common case completes before the response goes out. The outbox is the *backstop*, not
the mechanism.

The backstop needs something to run it, and this is where the reference splits across pages
in a way that genuinely confuses people. It is the **scope sweeper** — an alarm-driven
singleton Durable Object in the vertical's own deployment, calling `drainDue` over its
roster of scopes. Not the platform sweeper, which is a different clock doing different
work in a different place. Chapter 9 is both of them and the distinction.

### The trail joins

Splitting a change across two halves would otherwise split its audit trail. So admin rows
an executor writes carry `causedBy` — the id of the event that caused them.

That is the event id rather than a separate correlation field, because the envelope already
carries a unique kernel-stamped id, and reusing it avoids widening a frozen contract to say
something it already says.

## Platform intents: asking rather than calling

There is a third shape, for when a sandbox-clean vertical needs a privileged action —
provisioning a sibling scope, say — and holds no privilege at all.

`ctx.requestPlatform(request)` writes a durable row into this scope's
`_substrat_platform_requests` spine, atomic with the operation, exactly as `emit` is. The
platform pulls and executes it later, knowing the tenant inherently because it read this
scope's DO. Origin fields are stamped kernel-side; the call returns the new id.

Call it **after** your own permission check. Authorization is the vertical's decision;
isolation is the platform's. And it applies backpressure: a scope holding the maximum
pending intents throws rather than queueing without limit.

The outcome comes back. `ctx.platformRequests(filter)` reads this scope's own intent
journal — newest first, filterable by kind and status — with the `result` or `lastError`
the platform settled. That read exists for one concrete reason: a contract whose signature
request settled `failed` can say so on its own screen, instead of showing a document that
appears to be out for signature and is not. The kernel owns every write to that table, so a
status is only ever the platform's answer.

## Why an engine composed by event has no exports

The invoicing engine consumes `workorder.completed` *and* `commerce.order-placed` — events
from two different domains — without importing a single type from either producer. It has
deliberately **no in-scope exports**: the vertical emits, the engine consumes, and the
vertical reads results back through the engine's own operations or by consuming its events.

That is not an omission. The engine being the only writer of its rows is what keeps
invariants like immutable-after-export safe from a half-finished caller. Chapter 7 is when
to reach for that shape versus a direct call.

## Schema versions, and why dual-emit is not available

Event payload fields are **frozen once shipped**. Rename, remove or retype means a
`schemaVersion` bump, and a bump is a **replace** — you cannot emit v1 and v2 side by side
during a deprecation window.

The reason is mechanical rather than philosophical. Consumer dispatch selects on event
*type* alone (`WHERE o.type = ?`), and the `schemaVersion` a manifest's `consumes` entry
carries is discarded at registration. So emitting both versions delivers **both** to the
same consumer. For `invoicing.underlag-exported`, whose consumer is by design an accounting
connector, that is a double invoice in production, silently.

A replace fails loudly instead: a v1 consumer's strict parse rejects v2, and the event
dead-letters where somebody sees it. Loud and stopped beats quiet and doubled.

So no plan should promise a deprecation window that nothing can deliver. Routable
dual-emit needs `(type, schemaVersion)` in the dispatch predicate plus a version dimension
on the consumer registry — designed, filed, and postponed rather than abandoned.

## The event stream is the audit log

Because every event carries tenant, scope, actor, entity and time — stamped, not supplied —
the stream *is* the audit log. Complete by construction. "Who did what, when, to which
entity" is a query, and the answer is the same data reporting runs on.

Which is why reading one entity's history is a sanctioned projection over
`_substrat_outbox` — rule 3 bans *writes* to the spine, not reads — and why `readTimeline`
and `readHistory` exist rather than everyone writing their own `SELECT`.

---

**Next:** [Permissions and identity →](/book/06-permissions-and-identity)
