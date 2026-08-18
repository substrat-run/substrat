---
description: "Registering the booking engine, wrapping `hold` and `confirm` with your own rules, and the timezone boundary: the engine compares instants and never does calendar arithmetic."
---

# Composing & extending

## Using it as-is

Register it and the default bindings work:

```ts
import { bookingModule } from '@substrat-run/engine-booking';
host.registerModule(bookingModule);
```

That gets you resources, holds, confirms and availability under the engine's own permission
keys. Most verticals wrap `hold` and `confirm` instead, because that is where their own rules
live.

## The timezone boundary

**The engine is timezone-free.** It stores and compares absolute instants and never does
calendar arithmetic. All local wall-clock reasoning belongs to the vertical:

- the venue's **IANA zone** (never a fixed offset — offsets move with DST);
- recurrence defined in local wall time and materialised to instants, so a weekly 19:00 slot
  stays at 19:00 across a DST boundary;
- **absolute** durations — 90 minutes is 90 real minutes even across a transition;
- **nonexistent** local times (the spring-forward gap) rejected at input validation, and
  **ambiguous** ones (the autumn repeat) resolved to the earlier instant by convention.

The split is not fussiness. "Do these two bookings overlap?" is a question about physical
time; "19:00 on Tuesdays" is a question about human intent. Keeping them apart makes the
invariant trivially correct and the engine reusable in any locale.

## Wrapping it with vertical logic

The pattern: validate your own rules, resolve your own price, then hand the engine an
absolute interval and let it arbitrate.

```ts
const bookCourt: OperationHandler<BookInput, Booked> = async (ctx, raw) => {
  assertAllowed(await ctx.check(BK.hold));
  const input = bookInput.parse(raw);

  // Vertical: opening hours, allowed durations, price.
  const window = bookableWindow(ctx, input.resourceId, input.date);
  if (!window) throw new Error(`the club is closed on ${input.date}`);
  const startsAt = zonedToInstant(input.date, input.time, venue(ctx).timezone);
  const { price, label } = resolvePrice(ctx, input);

  // Engine: the only thing that decides whether the slot is free.
  const reservation = holdReservation(ctx, {
    resourceId: input.resourceId,
    startsAt,
    endsAt: addMinutes(startsAt, input.duration),
    expiresAt: addMinutes(now, venue(ctx).hold_minutes),
  });

  // Your own side table, keyed by the engine's id.
  ctx.sql.exec(`INSERT INTO rally_bookings (reservation_id, price_amount, …) VALUES (?, ?, …)`,
    [reservation.id, price.amount /* … */]);
  return { reservation, price, ruleLabel: label };
};
```

Note what is absent: **no clash check**. If the court is taken the engine throws
`SlotUnavailable`. A vertical that checks first is doing it wrong — it cannot do so correctly,
and the engine already does.

## Configuration

### Adding data to a reservation

Add your **own side table keyed by the engine's id** — never a column on the engine's tables,
which are private to it. Price, rule label, level band, whatever the domain needs.

### Holds are your policy

`expiresAt` is yours: ten minutes for a payment hold, the match start time for an open match
awaiting players. One mechanism, two products.

### Open matches ride the same mechanism

`fillTarget` plus a deadline *is* the open-match feature. Participants join; the engine
auto-confirms on reaching the target and expires the hold if the deadline passes unfilled. The
level bands, approval rules and cancellation windows around it are all vertical — the engine
knows only the number and the deadline.

## Composing with another engine

Star topology: `booking` never imports another engine, and none imports it. A vertical
composes both in one transaction — a workshop's drop-off is a `booking` while the repair is a
`workorder`; a club's confirmed booking raises an invoice through `invoicing`.

Because both run inside one scope, which is one Durable Object, the composition is atomic for
free. Debiting a prepaid balance and confirming a court either both happen or neither does —
"charged but not booked" is unrepresentable rather than merely unlikely.

## Portal reads

For "show me my bookings", declare an entity relation from `reservation` to whatever your
vertical calls a customer, link it when you create the reservation, and grant that customer
`booking:read` narrowed to their own record. Then iterate and `ctx.check(perm, entityRef)` per
reservation — a proof walk, not a `WHERE` clause on the caller.

## Reaching the outside world

The engine emits; it never calls out. Payment rails, notifications and calendar sync are
connectors draining the outbox. Module code has no network, and a booking engine that could
call a payment provider would be a booking engine you could not trust to be atomic.
