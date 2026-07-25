# @substrat-run/engine-workorder

Work-order engine for [Substrat](https://github.com/substrat-run/substrat) — one
engine covering **work orders, time reporting, and material reporting**. One state
machine, append-only reporting, and a billable snapshot frozen at completion.

It deliberately knows nothing about pricing (the vertical's job) or invoicing (a
sibling engine, reached only via events).

## What it owns

- **The state machine cannot skip states** — `planned → in_progress → completed → closed`.
- **Time and material are append-only** — corrections are compensating entries, never edits.
- **Attribution comes from the ambient principal**, never from the input.
- **Every mutation emits a fat event** — `workorder.completed` carries the full billable
  snapshot, so consumers never query back.

## Install

```sh
pnpm add @substrat-run/engine-workorder
```

```ts
import { createWorkOrder, PERM, workorderModule } from '@substrat-run/engine-workorder';

host.registerModule(workorderModule);

// Note: the engine registers no `workorder/create` operation. Creation is an
// in-scope function, because the vertical must price and label the order first.
host.defineOperation('acme/ticket-to-order', async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.create));
  return createWorkOrder(ctx, {
    facility: input.facility, // opaque EntityRef — the vertical owns facilities
    customer: input.customer,
    kind: 'felanmalan',
    title: input.title,
  });
});
```

## Documentation

**https://substrat.net/engines** — the domain model and invariants, the
full operation/permission surface, event contracts, and how to compose or extend it.

The docs site is the single source of truth; this README deliberately doesn't restate it.

## Related packages

- [`@substrat-run/kernel`](https://npmjs.com/package/@substrat-run/kernel) — the
  scope-host contract these operations run on
- [`@substrat-run/engine-invoicing`](https://npmjs.com/package/@substrat-run/engine-invoicing) —
  consumes `workorder.completed` into immutable invoice bases

## Status

Pre-release (0.x): surfaces change without notice until the first vertical ships.
