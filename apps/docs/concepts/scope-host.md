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
  invoke<O, I>(operation: string, input?: I): Promise<O>;
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
  entitlement(key: string): Promise<EntitlementView | null>;
  entitlements(): Promise<EntitlementView[]>;
  link(child: EntityRef, parent: EntityRef): void;
  grant(principal: PrincipalId, permission: PermissionKey, entity: EntityRef): Promise<void>;
  revoke(principal: PrincipalId, permission: PermissionKey, entity: EntityRef): Promise<void>;
  requestPlatform(request: PlatformRequestInput): PlatformRequestId;
  platformRequests(filter?: PlatformRequestFilter): PlatformRequest[];
  sealToConnection(provider: string, plaintext: string): Promise<SealedSecret>;
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
