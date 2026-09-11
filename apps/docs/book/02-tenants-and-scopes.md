# 2. Tenants, scopes, and one database each

Everything in Substrat hangs off one structural decision, and it is the one to understand
first, because every later mechanism is shaped by it.

## Two levels, tree-shaped

A **tenant** is the business that pays you. A **scope** is one isolation domain inside
that business.

<TenancyTree />

What a scope *means* is your vocabulary, not the kernel's. It is a `kind` string the
kernel never branches on: a housing association for a property manager, a branch for a
chain, a client company for an agency, a brand for a publisher. Users belong to the
tenant, to a scope, or to several scopes with different roles in each.

This shape is in nearly every vertical B2B product, and it is close to impossible to
retrofit — which is why it is kernel-owned rather than a convention you follow. Two
details are worth knowing early:

- **Scope IDs are globally unique ULIDs**, not per-tenant counters. An event or an opaque
  reference never needs the tenant to disambiguate. But every kernel API still takes the
  pair `(tenantId, scopeId)` and cross-checks it — so a confused-deputy bug in calling
  code **fails closed** rather than resolving to somebody else's scope.
- **`parentScopeId` exists and is always `null` today.** The column is there so deeper
  trees are an additive change later rather than a data migration.

The full entity definitions are in [Tenants & scopes](/concepts/tenancy).

## One scope, one database

Here is the part that matters. A scope is not a partition key. It is **its own database**.

On the local adapter, that is one SQLite file. On the hosted runtime, it is one
SQLite-backed Durable Object. There is no shared cluster and no shared table with a
`tenant_id` column in it. A query issued inside a scope is issued against storage that
contains that scope's rows and nothing else.

<ScopeTopology />

Follow the consequences:

**Cross-tenant reads are not prevented, they are unavailable.** There is no `WHERE
tenant_id = ?` to forget, because the other tenant's rows are not in the database you are
querying. The most common multi-tenancy bug in the industry has no syntax here.

**Blast radius is one scope.** A corrupted row, a runaway query, a migration that throws
— each is contained to one customer's one domain. There is no lock contention between
tenants because there is no shared lock.

**"Give me a copy of production" is a file copy.** Snapshots, forks and preview
environments (chapter 8) are cheap because a scope's entire state is one self-contained
thing. On a shared cluster this is a export-filter-import project; here it is a copy.

**Deleting a customer is deleting databases.** Reaping one scope destroys one file;
reaping a tenant walks every scope beneath it and then clears the tenant's own PII and
configuration rows. Which is a real property when somebody invokes a right to erasure, and
a real hazard too — chapter 10 covers what actually frees those bytes, because the answer
is less automatic than you would expect, and because the tombstones and the admin log are
built to survive it.

The cost is equally real: **you cannot join across scopes**. A question like "how many
work orders did this tenant complete this quarter, across all forty branches" is forty
reads and a fold, not one `GROUP BY`. [Reads & scaling](/concepts/reads) is the page on
how that is handled — projections, per-tenant D1, and what is honestly still open.

## Strict serialization

Inside one scope, **one operation runs at a time, to completion**, before the next one
starts.

This is a stronger guarantee than most databases give you and it eliminates a whole
category of code. No interleaved read-modify-write. No lost update. No row locking in
module code, no `SELECT … FOR UPDATE`, no optimistic-retry loop. A handler that reads a
balance, decides, and writes it back is correct as written, because nothing ran in
between.

It is enforced explicitly, on both adapters, by a per-scope task queue — about fifteen
lines of code:

```ts
export class OperationQueue {
  private tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(op: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(op);
    // The chain must survive failures; callers still see the rejection.
    this.tail = result.catch(() => undefined);
    return result;
  }
}
```

On Cloudflare this queue sits *in front of* the Durable Object's own input gate rather
than relying on it. The gate is real, but it over-delivers: it permits subtler
interleavings around non-storage awaits. Kernel and module code are allowed to depend on
strict serialization and nothing weaker, so the adapter enforces strict serialization
itself instead of inheriting whatever the platform happens to provide. The two adapters
then mean the same thing by "serialized", which is what lets one conformance suite hold
both.

The thing to notice is the pattern, because it repeats: where the platform's guarantee is
*close* to the contract, Substrat implements the contract anyway rather than documenting
the gap.

## The clone boundary

Inputs and results cross the scope boundary as **structured clones** — even when the
caller and the scope are in the same process.

So module code can never hold a reference to something outside its scope, and outside
code can never hold a reference into it. There is no object shared across the boundary to
mutate by accident. Locally this is deliberate extra work; on Cloudflare it is free,
because the boundary is a real RPC hop. Doing it locally too is what stops "works on my
machine, fails in production" from being a category of bug — the local runtime is the
strict one.

## Ambient tenancy

Once you hold a scope stub, you never pass a tenant or scope id again.

```ts
const stub = await host.getScope(principal, tenantId, scopeId);
await stub.invoke('workorder/create', { title: 'Leaking radiator' });
```

The handler behind `workorder/create` receives a context already bound to that tenant and
that scope. It has no parameter for them, so there is no parameter to get wrong, and no
call site where the right ids could be passed to the wrong operation.

Holding the stub *is* the authorization to talk to that scope — it is a capability, and
minting one is gated (chapter 3). The scope still re-validates every call against its own
access rules, because a capability that is never re-checked is a capability that cannot
be revoked.

## Where a scope lives is decided once

Two fields are fixed at provisioning and never change afterwards:

**`jurisdiction`** — `eu`, `us`, or `global`. Data residency is a property of the scope
from birth. `global` is the honest name for unconstrained, which is what every scope is
today; `eu` and `us` name guarantees whose enforcement (Durable Object jurisdiction
subnamespaces, Regional Services) is not built yet, so provisioning currently gates them.
The vocabulary ships ahead of the enforcement deliberately, precisely *because* the field
is immutable: a scope that took a value nobody could name later would be a data migration
rather than a config change.

**`storageShape`** — `A` (the DO's embedded SQLite is primary) for everything today; `B`
(a control-plane DO fronting per-tenant D1) is designed and not built.

A Durable Object cannot relocate. That is not a Substrat limitation but a platform one,
and it is why these are provisioning-time decisions rather than settings.

## The states a scope moves through

```
provisioning → active ⇄ suspended
                  ↓
              archiving → archived → reaped
```

`active` serves traffic. `suspended` fails closed — every `getScope` refuses — but the
data is intact and the transition is reversible. `archived` is inert and reversible; the
bytes are still there. **`reaped` is terminal**: the storage has been wiped, the
directory row survives as a tombstone for audit history and to burn the slug, and there
is no restore.

Tenants have a parallel ladder — `active`, `suspended`, `deleting`, `reaped` — where
`deleting` is a reversible grace state that makes every scope under it inert without
reclaiming anything.

What is worth flagging here, and what chapter 10 returns to: **nothing moves a scope from
`archived` to `reaped` on its own unless you have configured it to**. Cloudflare never
garbage-collects a Durable Object. An archived scope's bytes persist indefinitely until
something explicitly wipes them, and the sweep that can do that is opt-in because the
operation is irreversible.

---

**Next:** [The path of one request →](/book/03-one-request)
