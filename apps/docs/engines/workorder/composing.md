# Composing & extending

## Using it as-is

```ts
host.registerModule(workorderModule);
```

That's the whole registration surface. `registerModule` takes exactly one argument, and it's
a frozen constant.

## Wrapping it with vertical logic

The registered operations are **default bindings**. For custom flows, call the exported
in-scope functions from your own operation — same transaction, same serialization domain, and
the permission check becomes yours:

```ts
import { createWorkOrder, PERM } from '@substrat-run/engine-workorder';

host.defineOperation('acme/felanmalan-to-order', async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.create));
  ctx.sql.exec('UPDATE acme_tickets SET status = ? WHERE id = ?', ['converted', input.ticketId]);
  return createWorkOrder(ctx, {
    facility: ticketFacility(ctx, input.ticketId),
    customer: ticketCustomer(ctx, input.ticketId),
    kind: 'felanmalan',
    title: input.title,
  });
});
```

The ticket update and the order creation commit together or not at all.

`demos/callout/src/routes.ts` maps the seam precisely: `assign`/`start`/`close` go straight to
the engine, while `create-workorder` and `complete-workorder` (which needs billable lines
priced) route through `callout/*`.

## Configuration

**There is none, and that's deliberate.** `ModuleRegistration` has five fields — `manifest`,
`migrations`, `operations`, `consumers`, `predicates` — and none is config. There is no
`createWorkorderModule({...})` factory and no `config` field on the manifest. An engine cannot
be told anything at registration time.

*Configuration is dynamic; composition is code.* When you need the engine to behave
differently, you reach for one of these instead:

| You want | Use |
|---|---|
| only part of the engine | `withdraws` in your manifest — suppress a default binding, re-offer it behind your own operation |
| different behaviour around a transition | your own operation calling the in-scope function (above) |
| a parameterised rule | a guard predicate with `guards[].config` — kernel-opaque, parsed by the predicate that owns it |
| tenant-specific content | runtime data in your own tables |
| the engine off entirely for a tenant | revoke the `workorder` entitlement |

`entitlementKey` is a **binary SKU gate**, not a config knob: a tenant holds it or the
operations don't resolve. It's checked per invoke and fails closed. One caveat — bare
`defineOperation` glue carries no manifest and is **ungated**, so a vertical operation
wrapping an in-scope function bypasses the entitlement check.

### Adding data to an order

Never add a column upstream. A vertical needing extra fields on a work order adds **its own
side table keyed by the engine's order id**. Another module's tables are private; the stable
surface is entity ids, `EntityRef`s, and event payloads.

## Portal reads

The engine declares the edge that makes entity-narrowed access work:

```ts
entityRelations: [{ entityType: 'workorder', parentType: 'facility' }]
```

`createWorkOrder` records it with `ctx.link(orderRef, input.facility)`, so a
[capability grant](/concepts/permissions#capability-grants) on a facility reaches the work
orders under it. A portal customer gets an entity-narrowed `workorder:read` on their own
facility and `workorder/get` — which checks per-entity — does the rest.

## Reaching the outside world

Nothing in this engine talks to anything external, and it never will: module code may not
`fetch`, and connectors handle the outside world.

The seam is `workorder.completed` on the event spine. A **connector** — a third-party
capability living in the kernel-owned integrations hub, neither engine nor vertical — is what
would carry it outward.

::: info The seam is built; nothing consumes this event yet
The [connector seam](/connectors/) is real and running in production — `registerConnector`
binds a handler to an event type, the per-tenant connection store holds the credential sealed
at rest, delivery is at-least-once with retry and a dead letter, and a provider's callback
comes home through the inbound authority seam. The [Scrive connector](/connectors/scrive) uses
all four.

What is missing here is a **consumer**: nothing subscribes to `workorder.completed` today. This
seam is an opening nobody has taken yet, not a floor that hasn't been poured.
:::
