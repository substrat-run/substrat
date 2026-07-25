# @substrat-run/engine-booking

Reservation engine for [Substrat](https://github.com/substrat-run/substrat) —
**resources, intervals, and capacity**. It owns exactly one invariant and nothing else.

It knows nothing about pricing, opening hours, recurrence, cancellation windows, skill
levels, or timezones — all of that is vertical policy. It takes absolute instants and
compares them; it never does calendar arithmetic.

## What it owns

- **One invariant: capacity is never exceeded.** Concurrent allocations against a
  resource never exceed its capacity over any overlapping interval — enforced without
  row locks.
- **A hold → confirm lifecycle.** A `hold` is a provisional claim that `expires` on its
  own; `confirm` makes it firm; `move`, `cancel`, `start`, `complete`, and `no-show`
  carry it the rest of the way.
- **Attribution comes from the ambient principal**, never from the input.
- **Every mutation emits a fat event** — `booking.held`, `booking.confirmed`,
  `booking.moved`, `booking.completed`, … — so consumers never query back.

## Install

```sh
pnpm add @substrat-run/engine-booking
```

```ts
import {
  bookingManifest,
  createResource,
  holdReservation,
  confirmReservation,
  PERM,
} from '@substrat-run/engine-booking';
import { assertAllowed } from '@substrat-run/kernel';

host.registerModule(bookingManifest);

// The engine registers no `booking/hold` operation: the vertical decides what a
// resource is, what it costs, and when it is bookable — then composes the in-scope
// function inside its own operation, in the same transaction, after its own check.
host.defineOperation('salon/request-slot', async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.hold));
  return holdReservation(ctx, {
    resource: input.chair, // opaque EntityRef — the vertical owns resources
    from: input.from, // absolute instant
    until: input.until,
    holder: input.customer,
  });
});
```

## Documentation

**https://substrat.net/engines** — the domain model and the capacity invariant, the full
operation/permission surface, the event contracts, and how a vertical composes or extends it.

The docs site is the single source of truth; this README deliberately doesn't restate it.

## Related packages

- [`@substrat-run/kernel`](https://npmjs.com/package/@substrat-run/kernel) — the
  scope-host contract these operations run on
- [`@substrat-run/contracts`](https://npmjs.com/package/@substrat-run/contracts) — the
  branded IDs, `Money`, and manifest schemas in the surface

## Status

Pre-release (0.x): surfaces change without notice until the first vertical ships.
