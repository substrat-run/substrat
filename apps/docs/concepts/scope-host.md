# Operations & the scope host

The scope-host contract is the heart of the kernel: **module code registers operations;
callers reach a scope only through a capability stub.** The operation handler runs
*inside* the scope's execution domain, which is what makes invariants enforceable — the
handler sees `sql`, `emit`, `check`, and `link`; the caller sees only `invoke()`.

## The contract

```ts
interface ScopeHost {
  getScope(principal: PrincipalId, tenantId: TenantId, scopeId: ScopeId): Promise<ScopeStub>;
  provisionScope(actor: PlatformActorId, input: ProvisionScopeInput): Promise<void>;
  registerModule(registration: ModuleRegistration): void;
  // Out-of-band effects a module asks for but cannot perform — see
  // /concepts/events#the-connector-seam
  registerExecutor(id: string, eventType: string, handler: ExecutorHandler): void;
  defineOperation<I, O>(name: string, handler: OperationHandler<I, O>): void;
  readonly admin: HostAdmin; // control plane: roles/grants, tenant registry,
                             // scope lifecycle, entitlements, audit log
  close(): Promise<void>;
}

interface ScopeStub {
  readonly tenantId: TenantId;
  readonly scopeId: ScopeId;
  invoke<O, I>(operation: string, input?: I, options?: InvokeOptions): Promise<O>;
}
```

Operation names are module-namespaced: `'workorder/create'`, `'invoicing/export'`.

This is a teaching subset. The live `ScopeHost` has since grown a per-tenant relational
store (`provisionTenantStore` / `openTenantStore`), scope import/restore/snapshot
(`importScope`, `restoreScope`, `snapshotScope`), connector methods, and a scheduler seam
(`getSystemScope` opens a stub whose authority is a module on a timer, and
`registeredSchedules` / `runDueSchedules` let the [platform sweep](/concepts/platform#scheduled-work)
run a vertical's [recurring work](/concepts/modules#recurring-work-schedules)) — surfaces
the rest of these docs introduce where they belong.

`getSystemScope(moduleId, tenantId, scopeId)` is the mirror of `getConnectorScope`: a door
for a non-human caller. Where a connection's stub stamps `{ connection }` on its events, a
system stub stamps `{ system: moduleId }` and checks against `system:<moduleId>` grants — so
a scheduled operation is attributable to the schedule, and `ctx.check` stays its one gate.

### Preconditions travel per invocation, not in the input

`invoke`'s third argument carries facts about the **request**, never about the domain. A
handler's declared input is what the operation *means*; threading a retry token or an entity
tag through it would make every in-process caller state something it does not have.
`mountOperations` reads these off headers — a test, a seed or a schedule omits them entirely.

```ts
interface InvokeOptions {
  readonly ifMatch?: string;                                   // the caller's `If-Match`
  readonly onEntityVersion?: (version: string | null) => void; // the `ETag` to hand back
  readonly idempotencyKey?: string;                            // the caller's `Idempotency-Key`
  readonly onIdempotentReplay?: () => void;                    // sets `Idempotency-Replayed`
}
```

One bag rather than a parameter per concern, because the two are **one precondition pass at one
point in the invoke** — before the guards, inside the transaction.

- **`ifMatch`** is the version the caller believes it is writing over, verbatim from the header
  (quoted, and possibly a list). **`onEntityVersion`** is called after a guarded operation
  *commits*, with the entity's version as the caller's own write left it — read after the
  handler and inside the same transaction, because a client that echoed back the tag it sent
  would loop on its own stale value. Neither runs for an operation that declares no
  `concurrency`, and neither runs for one that rolled back.
- **`idempotencyKey`** has nothing to declare: it is honoured on every unsafe operation, since a
  retried write creating a second entity is a hazard on all of them. A first request under a key
  runs and its return value is recorded inside the operation's own transaction; a second under
  the same key returns that recording without running the handler, and **`onIdempotentReplay`**
  fires when it does.

**An option the operation cannot honour is refused, not ignored** — and refused before the
invocation takes its turn, in both directions:

- `ifMatch` sent to an operation that declares no `concurrency`. Nothing would have been
  compared, and a caller who believes its write is protected while it is not is the single
  failure this mechanism exists to prevent. Silence is how that belief survives.
- `idempotencyKey` sent to an operation that declared `idempotency: false`. Its response is
  deliberately never recorded, so the retry would do the work a second time — while the caller
  reads its `200` as proof that retrying was safe.

The HTTP half of both — the headers, the `412`, the replay window — is
[§7 and §7b of API design](/concepts/api-design#_7-writes-are-safe-to-retry).

## What a handler sees

```ts
interface OperationContext {
  readonly tenantId: TenantId;      // ambient — from the stub, not from the caller
  readonly scopeId: ScopeId;
  readonly principal: PrincipalId;
  readonly sql: ScopedSql;          // synchronous, scope-local SQL
  now(): Instant;                   // the operation's instant — the only clock
  emit(event: DomainEventInput): void;
  check(permission: PermissionKey, entity?: EntityRef): Promise<Decision>;
  search(entityType: string, term: string, options?: SearchOptions): SearchHit[];
  page<T>(entityType: string, params: PageParams): Page<T> | CountedPage<T>;
  versionOf(entity: EntityRef): EntityVersion | null;
  entitlement(key: string): Promise<EntitlementView | null>;
  entitlements(): Promise<EntitlementView[]>;
  link(child: EntityRef, parent: EntityRef): void;
  grant(principal: PrincipalId, permission: PermissionKey, entity: EntityRef): Promise<void>;
  revoke(principal: PrincipalId, permission: PermissionKey, entity: EntityRef): Promise<void>;
  requestPlatform(request: PlatformRequestInput): PlatformRequestId;
  platformRequests(filter?: PlatformRequestFilter): PlatformRequest[];
  sealToConnection(provider: string, plaintext: string): Promise<SealedSecret>;
  atomic<T>(fn: () => T | Promise<T>): Promise<T>;
}
```

- **`sql`** queries the scope's own database — synchronously, because the data is local
  to the execution domain. One network hop to reach the scope, then local queries.
- **`now`** is the operation's instant, and the **only** clock module code may read —
  `new Date()` and `Date.now()` are `boundary-lint` R6 violations, the same class of ban
  as `node:*`. It is **stable for the whole invocation**: every call returns the same
  value, so two rows written in one transaction cannot disagree about when they were
  written, and an event carries the same instant as the row it describes. The host
  injects it (`clock` on the host options), which is what makes elapsed time assertable —
  see [Testing with a clock](#testing-with-a-clock).
- **`emit`** validates the event input and stamps the envelope kernel-side (id,
  timestamp, tenant, scope, actor). See [Events & audit](/concepts/events).
- **`check`** asks the permission checker about the ambient principal at the ambient
  node, optionally narrowed to one entity. See [Permissions](/concepts/permissions).
- **`search`** returns entity ids from the FTS index the kernel derived from the
  manifest's `searchables` — a module never writes a `MATCH` of its own. An entity type
  nobody declared searchable throws `NotSearchable` rather than returning nothing.
- **`page`** reads one page of a declared entity: the kernel composes the `WHERE` from
  the operation's declared `filterable` columns, the `ORDER BY` from the caller's
  choice among `sortable`, the keyset cursor, the `LIMIT`, and — when the declaration
  asks for one — the total over the same `WHERE`. It reads the indexes it also
  provisioned. Rows come back wrapped; `mapPage` re-shapes the entries and keeps the
  cursor. An undeclared sort or filter throws (`SortNotDeclared`, `FilterNotDeclared`),
  never silently applies nothing. See [Lists are pages, not dumps](/concepts/api-design#_4-lists-are-pages-not-dumps).
- **`versionOf`** is an entity's version — the ULID of the last event about it, read
  from the outbox; there is no version column. It is what a read-modify-write's
  `If-Match` is checked against, and it survives a shred, so an erased entity can still
  refuse a stale write. The caller's side of that comparison is
  [`InvokeOptions.ifMatch`](#preconditions-travel-per-invocation-not-in-the-input); the
  transport's side is
  [A read-modify-write says what it is writing over](/concepts/api-design#_7b-a-read-modify-write-says-what-it-is-writing-over).
- **`entitlement`** / **`entitlements`** read the tenant's currently-held
  entitlements at request time — the sanctioned way a hosted vertical gates a feature
  or enforces its own quota *without* a control-plane binding. `entitlement(key)`
  returns the live `EntitlementView` (`key`, `plan`, `quota`, `expiresAt`) or `null`
  when the tenant does not hold the key; expiry is applied at read, so a non-null
  result is always live. The kernel enforces presence + expiry; the vertical decides
  what `quota` means. On a hosted vertical this reads a scope-local projection. See
  [The platform layer](/concepts/platform#entitlements-gate-modules-not-features).
- **`link`** records a child→parent relation tuple (e.g. work order → facility) used by
  the permission evaluator's entity-edge rule. The relation must be declared in a
  registered module's `entityRelations`. Idempotent.
- **`grant`** / **`revoke`** narrow a permission the caller **already holds** onto one
  entity — how an app expresses user-initiated sharing. Non-escalating by construction:
  `entity` is required, so module code can never write a scope- or tenant-wide grant, and
  the caller's own decision on that entity is re-checked first. **Delegation, never
  elevation.** Transactional with the operation, like its rows and its events. Without it,
  an app where a person shares their own record would need a membership table consulted by
  hand in every handler — the forgotten-`WHERE`-clause failure this platform exists to
  remove.
- **`requestPlatform`** / **`platformRequests`** enqueue a durable
  [platform intent](/concepts/platform#platform-intents) and read back what the platform did
  with it — the sandbox-clean way to ask for a privileged action, with no upward call and no
  credential in vertical code.
- **`sealToConnection`** seals a value to a *connection's* public key so it can ride on an
  event that a connector opens at egress. The scope never holds the private half; the
  consumer still needs no cross-module read, it just cannot read that one field. It takes a
  provider name (`'scrive'`), never a connection id — connection identity is the host's
  business, and an engine that learned it would be naming infrastructure it is not allowed to
  see. It **fails closed and legibly**: no projected key for that provider throws, rather
  than emitting a request that silently reaches nobody. Await it *before* `ctx.emit`, which
  is what lets `emit` stay synchronous.
- **`atomic`** runs a callback as a sub-transaction inside the operation's own. A throw
  inside discards everything the callback wrote — rows, events, links, grants, platform
  intents — while the operation's other writes survive, and it still commits once. This
  is the **only** place module code may catch an engine error: an engine call composed
  inside your transaction has no boundary of its own, so a bare `catch` would commit its
  partial writes. `boundary-lint` R7 rejects the unprotected form. A succeeded `atomic` is
  still provisional — if the operation later throws, its writes go too — and sub-transactions
  nest but must not interleave.

## Testing with a clock

Anything whose behaviour is a function of *elapsed* time — an absence request going
stale, a metering period rolling, a cart hold lapsing — is untestable against the wall
clock: the interesting branch never runs inside a 40 ms test. The usual workarounds are
to sleep (slow and flaky) or to shrink the window to zero, which proves that an
already-expired thing is expired and nothing about expiry.

The host takes a `clock`, so a suite can move time on purpose:

```ts
import { manualClock } from '@substrat-run/kernel';

const clock = manualClock('2026-03-02T09:00:00.000Z');
const host = new SqliteScopeHost({ dir, clock: clock.read });

await guest.invoke('shop/add-to-cart', { cartId, variantId, qty: 1 });

clock.advance(14 * 60_000);   // inside the 15-minute hold — still reserved
await expect(otto.invoke('shop/add-to-cart', { … })).rejects.toThrow(/out of stock/);

clock.advance(2 * 60_000);    // past it — the unit is sellable again
await otto.invoke('shop/add-to-cart', { … });
```

No real time passes. `frozenClock(at)` is the simpler form when a test only needs one
fixed instant. Both come from `@substrat-run/kernel`, so a vertical's own suite gets them
without depending on our test tooling.

**Timestamps are stored as ISO 8601 text.** `ctx.now()` returns an `Instant` — an ISO
string with an offset — and that is what goes in the column (`created_at TEXT NOT NULL`).
Text sorts and compares correctly, reads correctly in a `.sqlite` file someone opens by
hand, and needs no per-table convention about seconds versus milliseconds. Epoch integers
appear in this repo only inside a third-party schema that defines its own storage
(Better Auth's tables in `demos/auth-server`), which is that library's contract, not ours.

## Contract semantics — what every adapter guarantees

These are the semantics the [conformance suite](/reference/contract-tests) verifies, so
you can rely on them regardless of which adapter is underneath:

### Strict serialization per scope

One operation at a time, to completion. Ten concurrent read-await-write increments land
on exactly ten. Module code never needs locks, transactions-for-concurrency, or retry
loops against its own scope.

### Structured-clone boundary

Inputs and results are cloned on every stub call, both directions — even in-process.
Mutating an input object after `invoke()`, or mutating a returned result, can never
affect scope state. Code cannot share mutable state with a scope, so "it worked locally
because we shared memory" bugs are impossible by construction.

### Fail-closed addressing

`getScope` validates `(tenantId, scopeId)` against the directory. A mismatched pair
throws; it never resolves to another tenant's scope. The same fail-closed path also
gates lifecycle status: a suspended or deleting **tenant**, or a suspended or archived
**scope**, fails `getScope` — which is how suspend and archive actually contain.
Operations are gated once more at `invoke`: a module whose `entitlementKey` the tenant
does not hold does not resolve.

### Kernel-stamped events

The event envelope's origin fields are not parameters. See
[Events & audit](/concepts/events).

## In-scope functions vs registered operations

Engines expose their logic at two altitudes:

- **Registered operations** (`'workorder/create'`) — the default bindings, each starting
  with its own permission check. Invoke these through a stub.
- **In-scope functions** (plain exports like `createWorkOrder(ctx, input)`) — composable
  building blocks a *vertical's own operation* can call in the same transaction, when it
  needs to wrap engine behavior with domain logic (pricing, extra validation). The
  caller is then responsible for the permission check.

This is how a vertical customizes without forking: write your own operation, call the
engine's in-scope functions, keep everything inside one serialized, audited execution.

```ts
host.defineOperation('acme/create-priced-workorder', async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.create));
  const order = createWorkOrder(ctx, toEngineInput(input)); // engine function
  ctx.sql.exec('INSERT INTO acme_pricing ...');             // vertical's own table
  return order;
});
```

## Event consumers

A module can subscribe to event types (declared in its manifest under
`events.consumes`). Consumers run as ordinary in-scope operations under a **system
actor**, with at-least-once delivery tracked in a kernel delivery journal — so handlers
must be **idempotent**. Ordering is guaranteed only within one (scope, module) pair.

The [invoicing engine](/engines/invoicing/) is the reference example: it consumes
`workorder.completed` and rebuilds its own state from the event payload alone.
