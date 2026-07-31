# Events & audit

Every mutation in a Substrat system emits a **domain event**. Events are the audit trail,
the integration surface between engines, and the feed for reporting — one mechanism,
three jobs.

## What module code writes

```ts
ctx.emit({
  type: 'workorder.completed',   // module-namespaced
  schemaVersion: 1,
  entity: { entityType: 'workorder', entityId: order.id },
  piiClass: 'none',
  payload: { orderId: order.id, billable, total },
});
```

Everything identifying the **origin** is deliberately absent from the input. The kernel
stamps the envelope below the API surface:

```ts
type DomainEvent = {
  id: EventId;          // ULID — the idempotency key for consumers
  type: string;
  schemaVersion: number;
  occurredAt: Instant;  // stamped by kernel
  tenantId: TenantId;   // stamped by kernel
  scopeId: ScopeId;     // stamped by kernel
  actor: PrincipalId | { system: ModuleId } | { connection: string }; // stamped from the stub's context
  entity: EntityRef;
  piiClass: 'none' | 'pseudonymous' | 'direct';
  subjectId?: DataSubjectId;
  authorization?: EventAuthorization[]; // K-34 — stamped kernel-side (see below)
  payload: unknown;
};
```

The `actor` is one of three things, and never a person who wasn't one: a `PrincipalId`, a
`{ system: ModuleId }` — a consumer running under a system actor, **or a module's
[scheduled work](/concepts/modules#recurring-work-schedules) firing on a timer** — or a
`{ connection: string }` when a **connector** effected the write, an external provider's
callback acting through a connection. A connector or a nightly job that read as a human in
the audit trail would be worse than one that could not act at all, so each gets its own
member rather than a synthetic principal.

`authorization` records, per mutation, **which checks the emitting operation passed** (K-34):
each entry names a permission that was checked-and-passed, plus — when the allow resolved
through a capability grant rather than a role bundle — a ref to the granting tuple
(`workorder:01J…`, `scope:01J…`). It is stamped kernel-side (module code can neither supply
nor suppress it) and absent on events written before the field existed. The full proof chain
is not persisted — `explain` re-derives chains on demand; what re-derivation cannot recover
once tuples have changed is *which* permission and grant were consulted at write time, and
that pointer is what the envelope keeps.

A vertical cannot mislabel an event's origin, backdate it, attribute it to someone else,
or skip emitting where an engine emits — because the fields aren't parameters and the
emit sits inside the engine's operation, below anything the calling code controls.

## PII classification is mandatory

`piiClass` is required at the type level — an event that *could* carry personal data
cannot be declared without classifying it:

- **`none`** — no personal data in the payload.
- **`pseudonymous`** — references a person by opaque ID (a technician reporting time).
- **`direct`** — contains direct identifiers.

And the schema enforces the invariant that makes GDPR erasure implementable: **a
PII-classed event without a `subjectId` fails validation.** Crypto-shredding — erasing a
person by destroying their key — must always be able to key the erasure. Facts and
pseudonymous references survive (bookkeeping retention holds); the personal data becomes
unreadable.

## Events cross boundaries, queries don't

The composition rule for the whole system: engines and scopes integrate by **reacting to
each other's events**, never by querying each other's tables.

The [invoicing engine](/engines/invoicing/) demonstrates the pattern. It declares in its
manifest:

```ts
events: {
  consumes: [{ type: 'workorder.completed', schemaVersion: 1 }],
}
```

and registers a consumer that parses **its own view** of the payload — it never imports
the producer's types:

```ts
const onWorkOrderCompleted: ConsumerHandler = (ctx, event) => {
  const p = completedPayload.parse(event.payload); // own Zod schema of the contract
  // ...write invoicing tables from the snapshot
};
```

This is a *fat event* design: the payload carries what consumers need (billable lines,
prices, totals), so the consumer snapshots rather than joins. Prices are frozen at the
moment the event happened — which is exactly what an invoice wants.

## Delivery semantics

- Consumers run as ordinary in-scope operations under a **system actor**
  (`{ system: '@substrat-run/engine-invoicing' }` — visible as such in the audit trail).
- Delivery is **at-least-once**, tracked in a kernel delivery journal — consumers must
  be idempotent; the event `id` is the idempotency key.
- Ordering is guaranteed only within one (scope, module) pair.

## The connector seam

Consumers run **inside** the scope, so they can only touch that scope's data. Some
effects are not scope-local: adding someone to an organization writes tenant-wide
directory state, outside any one scope's transaction.

For those, a module *asks* and an **executor** effects:

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

Why not just write directly from the module? Because that would be a write to another
database inside a scope transaction: two independent commits, no coordinator, and an
orphaned membership if the scope rolls back after the directory write lands.

The connector has no such hazard. The event enters the outbox in the **same
transaction** as the domain write, so a rollback leaves no event and nothing to effect.
The executor then runs at-least-once from the outbox, exactly like a consumer.

**Dispatch is prompt** — inline after commit, with the outbox as the retry backstop.
The contract is eventually consistent, because that is what makes it correct under
crash, but the common case completes inside the originating request.

**The trail joins.** Splitting a change across two halves would otherwise split its
audit trail, so admin rows carry `causedBy` — the id of the event that caused them.
That is the event id rather than a separate correlation field: the envelope already
carries a unique kernel-stamped id, and reusing it avoids widening a frozen contract to
say something it already says.

## Audit as a product feature

Because every event carries tenant, scope, actor, entity, and time — stamped, not
supplied — the event stream *is* the audit log: complete by construction, not by
discipline. "Who did what, when, to which entity" is a query, and the answer is the same
data reporting runs on.
