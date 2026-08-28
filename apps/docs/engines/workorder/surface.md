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
| `workorder/list` | `workorder:read` | a page of orders, optionally filtered by status |
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
| `assignWorkOrder(ctx, input)` | `workorder/assign` | records the technician; the order stays `planned` |
| `startWorkOrder(ctx, input)` | `workorder/start` | `planned` → `in_progress` |
| `reportTime(ctx, input)` | `workorder/report-time` | appends a time entry, attributed to the acting principal |
| `reportMaterial(ctx, input)` | `workorder/report-material` | appends a material line |
| `completeWorkOrder(ctx, input)` | `workorder/complete` | validates + freezes billable lines |
| `closeWorkOrder(ctx, input)` | `workorder/close` | |
| `listOrders(ctx, page)` | `workorder/list` | a `Page<WorkOrder>` — `page` is the kernel's `PageParams` (`limit`, `sort`, `order`, `cursor`, `filters`), walked by `ctx.page` |
| `getWorkOrder(ctx, orderId)` | `workorder/get` | one order by id; throws on an id that names nothing |
| `getReportedLines(ctx, orderId)` | `workorder/get` | time + material for an order |

`listOrders` is **paged, not filtered by a positional `status?`**. The old
`listOrders(ctx, status?)` returned every matching row with no bound and a hard-coded sort;
it is gone rather than kept beside the paged read. Pass the status as a filter instead —
`listOrders(ctx, { filters: { status: 'planned' } })` — and read one order with
`getWorkOrder` rather than walking the list for it: once the list is a page, the row you
want is simply not on page one. See [Lists are pages, not dumps](/concepts/api-design#_4-lists-are-pages-not-dumps) for the walk.

None of these check permissions — that is the caller's job, by design. Calling one from your
own operation without `assertAllowed(await ctx.check(…))` first is a bug the linter won't
catch for you.

**What they return is parsed, not asserted.** Every value crossing back out of this engine
goes through the schema the engine publishes — `workOrder`, `timeEntry`, `materialLine` —
the same schema you point your own operation's `output` at. Engine surfaces evolve
additively (D-28), but that rule is held by review; the parse is what makes the failure it
prevents *loud*. A vertical compiled against 0.3 and running against 0.4, whose row shape
moved, used to read a field that had become `null` and render it — now the read throws at
the seam. Reads name their columns for the same reason: `SELECT *` would publish whatever
the physical table happens to hold.

Every operation is a thin binding of one of these — a permission check plus one call — so a
vertical that wants to report time *and* touch its own tables in one transaction composes
`reportTime` inside its own operation. The four reporting-side functions (`assignWorkOrder`,
`startWorkOrder`, `reportTime`, `reportMaterial`) take exactly the input their operation
declares and parse it on the way in.

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
