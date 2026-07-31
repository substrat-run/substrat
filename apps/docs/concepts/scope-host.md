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
  emit(event: DomainEventInput): void;
  check(permission: PermissionKey, entity?: EntityRef): Promise<Decision>;
  entitlement(key: string): Promise<EntitlementView | null>;
  entitlements(): Promise<EntitlementView[]>;
  link(child: EntityRef, parent: EntityRef): void;
}
```

- **`sql`** queries the scope's own database — synchronously, because the data is local
  to the execution domain. One network hop to reach the scope, then local queries.
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
