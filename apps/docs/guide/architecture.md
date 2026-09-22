# Architecture

Substrat is one decomposition seen two ways: a stack of **layers** (what the code *is*)
and a request path across **isolated databases** (how it *runs*). Both pictures are below.

## The three layers

Everything hangs off one split — humans and hard guarantees below the line, AI velocity
above it. Every band is a real, shipping package.

<LayerStack />

## Topology

<ScopeTopology />


The invariants this picture encodes:

- The **only** data path from vertical code to operational data is the scope stub.
  Holding a stub *is* the authorization to talk to that scope — and the scope still
  re-validates every call against its own ACL.
- **Events are emitted below the API surface.** Vertical code cannot emit on another
  scope's behalf, suppress an audit event, or edit its envelope.
- **Ambient tenancy.** After obtaining a stub, vertical code never passes tenant or
  scope IDs again — context rides inside the stub and the operation context. There is no
  ID parameter to get wrong.

## The scope: unit of isolation and consistency

A **scope** is one isolation domain — a housing association, a branch office, a client
company, a brand. Each scope has:

- **its own database** (one SQLite file locally; a SQLite-backed Durable Object on the
  Cloudflare adapter),
- **strict serialization** — one operation at a time, run to completion. No interleaved
  read-modify-writes, no lost updates, no need for row locking in module code,
- **a structured-clone boundary** — inputs and results are cloned even in-process, so
  code can never share mutable state with a scope.

Operations run *inside* the scope's execution domain: one hop to reach the scope, then
local, synchronous SQL. This is what makes engine invariants enforceable — the handler
sees `sql`, `emit`, and `check`; the caller sees only `invoke()`.

See [Tenants & scopes](/concepts/tenancy) and
[Operations & the scope host](/concepts/scope-host).

## Contracts first, adapters below

Every boundary-crossing data shape is a [Zod](https://zod.dev) schema in
[`@substrat-run/contracts`](/reference/contracts) — the reviewed artifact *is* the runtime
validator ("parse, don't trust"). The kernel's behavioral seams are pure TypeScript
interfaces in [`@substrat-run/kernel`](/reference/kernel) that import no platform APIs.

Platform specifics live only in **adapters**:

| Adapter | Backing | Use |
|---|---|---|
| [`@substrat-run/adapter-sqlite`](/reference/adapter-sqlite) | one SQLite file per scope, per-scope actor | local dev, CI, self-host |
| [`@substrat-run/adapter-cloudflare`](/reference/adapter-cloudflare) | SQLite-backed Durable Object per scope + a durable control-plane DO | production |

The rule is testable and non-negotiable: **a module's contract tests must pass unchanged
on both adapters** — and they do: the shared [conformance suite](/reference/contract-tests)
runs green on the pure-SQLite adapter in Node *and* on the Cloudflare adapter in real
`workerd` against Durable Objects. Neither is a mock; both implement the same semantics
(serialization, clone boundary, fail-closed addressing, stamped envelopes). This is what
makes local development deterministic, CI cloud-free, and the self-host/escrow story
literally true — and it's how a vertical moves from laptop to Cloudflare with no code change.

## The hosted runtime

The topology above is adapter-neutral. Here is what it becomes on the **Cloudflare
adapter** — the production shape. The one thing to hold onto: **every box is a Durable
Object with its own SQLite.** There is no shared cluster; a tenant's data sits in its own
isolated database, and the router's only job is to find the right door.

<RuntimeTopology />

## Modules: how everything joins

Engines and verticals join a host the same way — as **modules**. A module registration
bundles:

- a **manifest** — self-describing metadata: permissions (with human-readable
  descriptions), events emitted and consumed, migrations, attachment targets, entity
  relations, an entitlement key, and optional UI contributions;
- **migrations** — plain SQL, journaled per module, applied lazily per scope inside the
  scope's serialization domain;
- **operations** — named handlers (`'workorder/create'`) invoked through scope stubs;
- **event consumers** — handlers for event types other modules emit;
- **schedules** — recurring work, fired by the deployment's own sweeper under a system actor
  rather than by a cron the module holds.

A vertical increasingly does not *write* most of that. It declares its entities, operations
and permissions once in [the model](/concepts/model), and the manifest's entity fragments,
permission list, event list and DDL are **derived** from that declaration — with CI failing on
drift between the declaration and what is checked in.

See [Modules & the manifest](/concepts/modules).

## Calling another vertical: the peer door

Two verticals of one tenant sometimes need each other's operations. A board-room app reads
customers from a CRM, for example. Neither call is a person acting, so there is no user token
to carry, and an API key pasted into the other app's settings would be a second enforcement
system beside the kernel. Instead, the platform says which app is calling:

- **The target declares its peers.** The `peers` entry in its module manifest names the calling
  vertical, the operations it may invoke and the permissions it holds while doing so. Those are
  granted as `vertical:<slug>` at provisioning and listed in `PERMISSIONS.md`, so widening what
  another app may do is a reviewed permission diff. See
  [peers](/concepts/permissions#another-app-of-the-same-tenant-peers).
- **The caller acts as itself**, recorded as `{ vertical, scope }`: the calling app and the
  instance that called. Checks inside the operation are ordinary, no person comes along, and
  the caller holds no credential of its own.
- **Same tenant only.** The target is found by slug, as the tenant's one primary, active
  instance of that vertical. It is never found by hostname or in another tenant, it is never a
  preview, and it is never guessed when a tenant runs two instances.
- **Revocation takes effect on the next call.** A tenant can switch a peer off on a scope. That
  removes everything the peer held there, and no re-provision gives it back. A caller that has
  been suspended or uninstalled is refused on its next call.

### Writing one

The **target** declares who may call it, in its module manifest. The keys are derived from the
operations each peer may invoke, so the two halves cannot drift apart:

```ts
// spec/model.ts — the CRM's own operations, as any model-first vertical declares them
export const crmOperations = defineOperations(crmEntities, CRM_PERMISSIONS)({
  'customer/list': { summary: 'List customers', permission: 'customer:read', /* … */ },
  'customer/get': { summary: 'One customer', permission: 'customer:read', /* … */ },
  'customer/delete': { summary: 'Delete a customer', permission: 'customer:manage', /* … */ },
});

// src/manifest.ts
export const crmManifest = moduleManifest.parse({
  id: '@acme/crm',
  // … the rest of the manifest
  ...peersDeclaredBy(crmOperations, {
    // The board-room app may list and read customers. `customer:read` is read off those
    // two operations; `customer:manage` is not, so deleting stays out of reach.
    'acme/board-room': ['customer/list', 'customer/get'],
  }),
});
```

That lands in the CRM's `PERMISSIONS.md`, so widening what another app may do is a reviewed
permission diff rather than a quiet edit.

The **caller** declares the verticals it calls, in its `package.json` — the same place
`outbound` names the third-party hosts it may reach:

```json
{ "substrat": { "slug": "acme/board-room", "calls": ["acme/crm"] } }
```

Then it calls, with no address, no token and no allowlist entry of its own:

```ts
import { peerClient } from '@substrat-run/vertical-host';

const { items } = await peerClient('acme/crm').invoke<{ items: { id: string; name: string }[] }>(
  'customer/list', { limit: 50 },
);
```

Module code — an operation, a consumer, a schedule — takes the other leg, because it runs
inside the scope's Durable Object where there is no network at all. It enqueues the call and
the platform delivers it, at-least-once:

```ts
import { PEER_INVOKE_KIND } from '@substrat-run/contracts';

const requestId = ctx.requestPlatform({
  kind: PEER_INVOKE_KIND,
  payload: { vertical: 'acme/crm', operation: 'customer/list', input: { limit: 50 } },
});
```

The request ID is an enqueue receipt, not the operation result. The drain uses it as the
idempotency key; inspect the platform request for delivery status.

Both hosted legs are gated by the same `calls` declaration, and the caller on both is the scope the
platform found the work in — never anything the request or the payload said.

### The refusals, and what each means

| What you see | What happened |
|---|---|
| `this app declares it calls X, and you do not run one` | The tenant has no instance of the target. Not an error — the ordinary state of a fresh install. |
| `403` naming `substrat.calls` | The caller did not declare this target. Add it and push. |
| `403` naming the peer's slug | The target's `peers` does not name this caller, or names it without the operation. |
| `403` "switched off" | A tenant pulled the kill switch on this peer. Only restoring it gives access back. |
| `409` "runs N instances … bind the instance first" | The tenant runs two live instances of the target, so "the instance of X" has no single answer. Instance binding is not available yet ([#1720](https://github.com/substrat-run/substrat/issues/1720)); keep one active primary target. |
| `403` from a preview | A preview never makes peer calls. Run the two locally against the pure host instead. |

### A complete local example

This Node harness runs two verticals in one tenant. It declares a read operation, derives the
peer's permissions from that operation, makes a call, cuts access off, and restores it. There
are no migrations or persisted domain rows: the CRM returns one fixed example customer.

In an ESM project using the packages from this release, install the dependencies:

```sh
npm install @substrat-run/contracts @substrat-run/kernel @substrat-run/adapter-sqlite zod
npm install --save-dev tsx
```

Save the following as `peer-example.mts`, then run `npx tsx peer-example.mts`:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  defineEntities, defineOperations, errorCodeOf, manifestOperations, moduleManifest,
  operationInputsOf, peersDeclaredBy, permissionKey, platformActorId, scopeId, tenantId,
} from '@substrat-run/contracts';
import { assertAllowed, ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { createLocalVerticalBroker } from '@substrat-run/adapter-sqlite/vertical-broker';

const operations = defineOperations(defineEntities({}), ['customer:read'] as const)({
  'customer/list': {
    summary: 'List customers',
    permission: 'customer:read',
    input: z.object({ limit: z.number().int().min(1).max(50) }),
    output: z.object({ items: z.array(z.object({ id: z.string(), name: z.string() })) }),
  },
});
const manifest = moduleManifest.parse({
  id: '@acme/crm', version: '1.0.0', kernelContract: '^0.0.1',
  entitlementKey: 'crm', attachmentTargets: [],
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  ...manifestOperations(operations, { permissions: { 'customer:read': 'Read customers' } }),
  ...peersDeclaredBy(operations, { 'acme/board-room': ['customer/list'] }),
});
const dir = mkdtempSync(join(tmpdir(), 'substrat-peer-example-'));
const crm = new SqliteScopeHost({ dir: join(dir, 'crm') });
const board = new SqliteScopeHost({ dir: join(dir, 'board') });
const staff = platformActorId.parse(ulid());
const tenant = tenantId.parse(ulid());
const crmScope = scopeId.parse(ulid());
const boardScope = scopeId.parse(ulid());

try {
  crm.registerModule({
    manifest, migrations: [], operationInputs: operationInputsOf(operations),
    operations: {
      'customer/list': async (ctx) => {
        assertAllowed(await ctx.check(permissionKey.parse('customer:read')));
        return { items: [{ id: 'example', name: 'Example company' }] };
      },
    },
  });
  for (const host of [crm, board]) {
    await host.admin.createTenant(staff, { id: tenant, slug: 'example', name: 'Example' });
  }
  await crm.admin.grantEntitlement(staff, tenant, 'crm');
  await crm.provisionScope(staff, { tenantId: tenant, scopeId: crmScope, vertical: 'acme/crm' });
  await board.provisionScope(staff, { tenantId: tenant, scopeId: boardScope, vertical: 'acme/board-room' });
  await crm.admin.activateScope(staff, tenant, crmScope);
  await board.admin.activateScope(staff, tenant, boardScope);

  const broker = createLocalVerticalBroker({ 'acme/crm': crm, 'acme/board-room': board });
  const caller = broker.clientFor({ vertical: 'acme/board-room', tenantId: tenant, scopeId: boardScope });
  const read = () => caller.invoke('acme/crm', 'customer/list', { limit: 50 });
  const expected = { items: [{ id: 'example', name: 'Example company' }] };
  assert.deepEqual(await read(), expected);

  const peer = { vertical: 'acme/board-room', node: { tenantId: tenant, scopeId: crmScope } };
  await crm.admin.revokeFromPeer(staff, { ...peer, reason: 'Exercise the switch' });
  await assert.rejects(read, (error: unknown) => errorCodeOf(error) === 'forbidden');
  await crm.admin.restoreToPeer(staff, { ...peer, reason: 'Exercise complete' });
  assert.deepEqual(await read(), expected);
  console.log('Peer call, refusal, and restore passed.');
} finally {
  await crm.close();
  await board.close();
  rmSync(dir, { recursive: true, force: true });
}
```

The broker belongs only in a Node harness or test. It verifies the caller's live primary
scope and uses the target's real peer door; it does not exercise hosted `substrat.calls`
enforcement, egress, or service bindings. Never import it into module or Worker code.

### Seeing and changing access

After installation, the dashboard app page shows **App-to-app access**: declared outgoing
targets and incoming peers. A target that is not installed is neutral. For an incoming peer,
**Cut off** and **Let back in** require a reason; the status shows who switched access off,
when, and why. The console's scope page offers the same controls in **Peers**. A failed
status read is unknown, never permission to call. Re-provisioning does not restore access.

### Hosted rollout (platform operators)

Deploy the router with `apps/router/src/index.ts` as its entry module; it exports the public
fetch handler and the named `PeerCalls` entrypoint. Then deploy the egress worker with this
service binding in `apps/vertical-egress/wrangler.jsonc`:

```json
{ "binding": "PEER_CALLS", "service": "substrat-router", "entrypoint": "PeerCalls" }
```

The test environment binds `substrat-router-test` instead. Both declarations are checked in.
Update the control plane for peer delegation and async delivery, and redeploy participating
verticals with the peer routes and declarations from this release. Use the existing platform
secret configuration. A missing `PEER_CALLS` binding fails closed with a refusal naming the
binding and config file; it never falls through to an outbound fetch. An old target without
the status/switch routes requires a redeploy. These are deployment steps, not actions an app
author performs by adding `substrat.calls`.

## Composition: star topology

Engines talk to the kernel, **never to each other**. No engine imports or calls a
sibling. Composition happens through three kernel-mediated channels:

1. **Opaque refs** — attachment contracts bind to `(entityType, entityId)` without
   knowing what the entity is.
2. **Events** — an engine reacts to another's schema-versioned events. A contract, not a
   call: the [invoicing engine](/engines/invoicing/) consumes `workorder.completed` *and*
   `commerce.order-placed` — events from two different domains — without importing a single
   type from either producer.
3. **Vertical-owned orchestration** — synchronous flows that need two engines are wired
   in the vertical, where the glue is visible and editable.

This keeps compatibility at *N* kernel contracts instead of *N²* engine pairs, and keeps
each engine independently versioned. The corollary test: *if two engines need chatty
synchronous communication, they are one engine drawn wrong* — which is why "work orders +
time reporting" is one engine, not two.

## Between verticals: exports and imports

The same rule holds one level up. Two verticals of one tenant, such as a CRM and a board-room
app, each in its own scope with its own audience, integrate by event. Neither reaches into the
other's data. Each side declares its half:

- The producer **exports** what may leave: `events.exports`, each type with the permission a
  receiver must hold. An emitted type that is not exported never leaves its scope.
- The consumer **imports** what it takes, and names the vertical it comes from:
  `events.consumes: [{ from, type, schemaVersion }]`. Its handlers go under `imports` in its
  module registration.

Delivery is a **pull on a watermark the consumer keeps**. The platform reads the producer's
outbox after that watermark, inside the producer's scope and through the producer's own code,
then hands the batch to the consumer. The consumer runs each handler in its own transaction
together with its delivery record, which makes delivery at-least-once with one effect per event
per module. It then moves the watermark, last, in its own database. As a result:

- A consumer installed after the producer receives the exported history.
- Restoring the consumer re-delivers whatever the restore undid.

- **Same tenant only.** The platform resolves each end as the tenant's one primary instance of
  that vertical. It never resolves by hostname or across tenants. A preview or a fork is never
  either end.
- **Identity is the [peer door](/concepts/permissions#another-app-of-the-same-tenant-peers).**
  The receiver must hold the export's key, as `vertical:<slug>`, in the producer's scope. The
  producer enters the consumer's scope as itself, `{ vertical, scope }`, and its handlers' checks
  are real. A peer switched off on either side **pauses** the edge: nothing is read, the
  watermark holds, and nothing is lost when the peer is switched back on.
- **Only events classified `piiClass: 'none'` cross.** Erasing a subject cannot reach what
  another vertical derived from a payload, so personal data travels by a governed call instead.
  A classified event is withheld: the consumer is told it was sent, and never receives its content.
- **Loops are cut.** An event's cause chain may cross at most 8 vertical boundaries.
- **Every edge is visible.** Each platform sweep reports every edge as delivered, idle,
  paused or unresolved. A paused or unresolved edge also writes a sweep-run record with the
  reason.

Still to come:
- The hosted transport: the control plane reaching both scopes, and delivery within seconds
  of a commit rather than at the next sweep.
- A way to replay from an earlier watermark.
- An edge-health view.
- A breaking-change check on exported event payloads.

## Language: TypeScript end-to-end

Verticals are TypeScript regardless of what the kernel is written in — React UIs,
prompt-to-app tools, and coding agents all emit it. Keeping the kernel in TypeScript
means one source of truth at the most important interface in the system: "invalid states
unrepresentable" materializes directly at the SDK boundary (branded ID types, discriminated
unions, literal types) rather than through generated bindings.

Types erase at runtime, so they are never the enforcement: every trust boundary validates
at runtime with the same Zod schemas, and the guarantees that matter are structural — the
scope boundary, capability stubs, kernel-side stamping — not type-level. Types are
ergonomics, especially for agents; the enforcement doesn't depend on the compiler.
