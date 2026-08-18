---
description: "The work-order engine's two surfaces: operations invoked through a scope stub, and in-scope functions a vertical calls inside its own transaction — plus its permission keys and entitlement."
---

# Operations, functions & permissions

An engine has **no endpoints**. It exposes two surfaces, and the difference between them is
the whole extension model:

- **Operations** — named handlers invoked through a scope stub. Each is a default binding
  that does its own permission check.
- **In-scope functions** — plain exports a vertical calls *inside its own operation*, in the
  same transaction, where the vertical owns the permission check.

HTTP is derived, never authored: a manifest may point at an emitted OpenAPI spec via its
`api` field. Nothing in the engine speaks HTTP.

## Operations

| Operation | Permission | Does |
|---|---|---|
| `workorder/get` | `workorder:read` (per-entity) | one order with its time and material |
| `workorder/list` | `workorder:read` | orders, optionally by status |
| `workorder/assign` | `workorder:assign` | assign a technician (order stays `planned`) |
| `workorder/start` | `workorder:report` | `planned` → `in_progress` |
| `workorder/report-time` | `workorder:report` | append a time entry |
| `workorder/report-material` | `workorder:report` | append a material line |
| `workorder/complete` | `workorder:complete` | freeze billable lines, `in_progress` → `completed` |
| `workorder/close` | `workorder:close` | `completed` → `closed` |

`workorder/get` checks per-entity (`ctx.check(PERM.read, orderRef(id))`), which is what makes
the customer-portal walk work — see [Composing](./composing#portal-reads).

::: tip There is no `workorder/create` operation — and that is the design
The engine registers no `create`. Creation is the in-scope function `createWorkOrder(ctx, …)`
only, because **the vertical must price and label the order first**: it arrives from a
felanmälan, a booking, a ticket. `demos/callout` reaches it through `callout/create-workorder`.

The hole is deliberate and load-bearing — the engine owns the state machine, the vertical
owns vocabulary and pricing, and the engine leaves a gap exactly where the vertical belongs.
It's also why an engines-only scope can't do anything on its own:
*configuration is dynamic; composition is code.*
:::

## In-scope functions

```ts
import { createWorkOrder, completeWorkOrder, PERM } from '@substrat-run/engine-workorder';
```

| Function | Backs | Notes |
|---|---|---|
| `createWorkOrder(ctx, input)` | *(no operation)* | the deliberate hole above |
| `completeWorkOrder(ctx, input)` | `workorder/complete` | validates + freezes billable lines |
| `closeWorkOrder(ctx, input)` | `workorder/close` | |
| `listOrders(ctx, status?)` | `workorder/list` | |
| `getReportedLines(ctx, orderId)` | `workorder/get` | time + material for an order |

None of these check permissions — that is the caller's job, by design. Calling one from your
own operation without `assertAllowed(await ctx.check(…))` first is a bug the linter won't
catch for you.

::: warning Not every operation has an in-scope function yet
`assign`, `start`, `report-time`, and `report-material` carry their logic **inline in the
operation handler**, so there is no composable export behind them. A vertical that wants to
report time *and* touch its own tables in one transaction cannot currently do it through the
engine — the convention ("engine operations are thin: a permission check plus one exported
in-scope function") is not yet met here. Unlike the missing `create`, this asymmetry is an
artifact, not a decision.
:::

## Permissions

Declared in the manifest with descriptions — fuel for the
[permission-review diff](/concepts/permissions):

| Key | Description |
|---|---|
| `workorder:create` | Create work orders |
| `workorder:read` | Read work orders, time and material |
| `workorder:assign` | Assign a technician |
| `workorder:report` | Start work, report time and material |
| `workorder:complete` | Complete a work order (with billable lines) |
| `workorder:close` | Close a completed work order |

`workorder:create` is declared even though no operation binds it: `createWorkOrder` is
composed by verticals, which check this key themselves.

Typical role shapes: a *technician* gets `read` + `report`; a *coordinator* adds `create` +
`assign` + `complete`; closing (the bookkeeping-facing act) can be reserved for back-office.

## Entitlement

`entitlementKey: 'workorder'`. A tenant that doesn't hold the flag can't resolve these
operations — checked per invoke, fails closed. It's a binary SKU gate, not configuration; see
[Composing](./composing#configuration).
