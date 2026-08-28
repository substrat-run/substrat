# Operations, functions & permissions

## Operations

Registered bindings, each one a permission check plus a call into the in-scope function
below.

| Operation | Permission | Does |
|---|---|---|
| `booking/create-resource` | `booking:manage-resources` | add a bookable resource |
| `booking/set-resource-active` | `booking:manage-resources` | take one out of service |
| `booking/list-resources` | `booking:read` | a page of resources, optionally filtered by `kind` |
| `booking/hold` | `booking:hold` | tentative hold; throws `SlotUnavailable` |
| `booking/confirm` | `booking:confirm` *(per reservation)* | held → confirmed, re-checking capacity |
| `booking/expire` | `booking:confirm` | surface a lapsed hold as `expired` |
| `booking/join` | `booking:create` *(per reservation)* | add a participant; auto-confirms at `fillTarget` |
| `booking/leave` | `booking:cancel` *(per reservation)* | soft-leave |
| `booking/cancel` | `booking:cancel` *(per reservation)* | held/confirmed → cancelled |
| `booking/move` | `booking:move` *(per reservation)* | reschedule; throws `SlotUnavailable` |
| `booking/open` | `booking:confirm` *(per reservation)* | put places on offer on an existing reservation, or close it again |
| `booking/start` · `complete` · `no-show` | `booking:complete` | service transitions |
| `booking/get` | `booking:read` | one reservation with its participants |
| `booking/list` · `availability` | `booking:read` | paged reads — a `Page<Reservation>` / `Page<FreeInterval>` |

Checks marked *(per reservation)* pass an `EntityRef`, so a consumer holding an
entity-narrowed grant reaches their own booking and no one else's.

## In-scope functions

The composable surface. A vertical calls these **inside its own operation and its own
permission check**, in one transaction — this is how you extend the engine without forking
it.

```ts
createResource(ctx, { kind, name, capacity? })            → Resource
setResourceActive(ctx, { resourceId, active })            → Resource
listResources(ctx, kind?)                                 → Resource[]
holdReservation(ctx, { resourceId, startsAt, endsAt,
                       expiresAt, quantity?, fillTarget? }) → Reservation  // throws SlotUnavailable
confirmReservation(ctx, { reservationId })                → Reservation
expireReservation(ctx, { reservationId })                 → Reservation
joinReservation(ctx, { reservationId, partyRef, share? }) → { participant, reservation }
leaveReservation(ctx, { reservationId, participantId })   → Reservation
moveReservation(ctx, { reservationId, resourceId?,
                       startsAt?, endsAt? })              → Reservation  // throws SlotUnavailable
openReservation(ctx, { reservationId, fillTarget })       → Reservation  // null closes it again
cancelReservation · startReservation · completeReservation · markNoShow
getReservation(ctx, reservationId, now?)  → { reservation, participants }
listReservations(ctx, { resourceId?, from?, to? }) → Reservation[]
availability(ctx, { resourceId, from, to })        → FreeInterval[]
effectiveStateOf(state, expiresAt, now)            → ReservationState

// the paged twins — what the three list operations answer
listResourcesPage(ctx, page)                       → Page<Resource>       // page: PageParams, filters: { kind? }
listReservationsPage(ctx, { resourceId?, from?, to?,
                            limit?, cursor? })     → Page<Reservation>    // cursor is the reservation id
availabilityPage(ctx, { resourceId, from, to,
                        limit?, cursor? })         → Page<FreeInterval>   // cursor is a segment's startsAt
```

### The paged twins

Each list operation answers with a `Page<T>` — `{ entries, nextCursor }` — and the function
behind it is the `…Page` twin, not the array-returning fold above it. Both stay exported on
purpose: `listResources(ctx, kind?)` and `listReservations(ctx, window)` are in-scope folds a
vertical calls inside its own transaction, where the bound is the vertical's (a club has eight
courts, not eight thousand). The unbounded read that paging was introduced against is the
invocable *endpoint*, and that is what the twins back.

They page differently, and the difference is the cursor. `listResourcesPage` is
kernel-composed: `ctx.page` builds the `WHERE`, the `ORDER BY` and the keyset tie-break from
the operation's declared `paged` vocabulary, so it takes the kernel's `PageParams` (`limit`,
`sort`, `order`, `cursor`, `filters`, `total`) — and with `total: true` it returns a
`CountedPage` carrying the filtered count. `listReservationsPage` owns its own `WHERE` because
the window is an overlap test (`starts_at < to AND ends_at > from`), which the kernel's
equality-only filter vocabulary cannot express. Its rows come back **ordered by reservation
`id`**, the cursor is exclusive (`id > cursor`), and the walk is *not* globally ordered by
`startsAt` — `startsAt` is not unique on a court schedule, so a caller rendering a calendar
sorts the page it got by `startsAt` itself. `availabilityPage` runs the whole fold and takes
the page off the end of it (the segments are derived by merging every live reservation in the
window, so there is nothing partial to push into SQL); its segments are disjoint and ordered,
which is what makes `startsAt` a sound cursor there. Neither handler-composed twin counts:
they page with `pageOf`, so there is no `total` to ask for.

### `move`, not `update`

`moveReservation` changes resource and/or interval, re-runs the allocation check **excluding
itself** (so nudging a booking that overlaps its own old slot is legal), and keeps the
reservation's identity, roster and payments. Passing `startsAt` alone *shifts* it, preserving
duration — what dragging a calendar cell means.

It is explicitly not cancel-then-rebook, which would lose all three. And there is no generic
`updateReservation`: engines model named transitions, participants are an append-only log
rather than a patchable field, and `booking.moved` carrying from/to is worth more to a
consumer than a permanent diff blob.

### `open` — a reservation can be put on offer after the fact

`fillTarget` is engine state: it drives the auto-confirm in `joinReservation`. So a
booking cannot be opened to others by a vertical keeping its own counter beside the
engine's and hoping the two stay in step — `openReservation` sets it, and `null`
closes it again into a private booking.

Additive: reservations made without a target are unaffected. A target below the
people already on the reservation is refused rather than silently stranding one of
them.

This is what lets the three shapes of "open game" share one mechanism: a club
opening a court with nobody on it, a player opening one they are on, and a player
opening a booking they already hold.

### `availability` returns intervals, not slots

`FreeInterval[]` — `{ startsAt, endsAt, available }`, merged, with `available` a **number**
because capacity may exceed 1. It reports raw gaps between reservations and knows nothing of
opening hours: left alone it will happily call 03:00 free. Intersecting with the venue's
bookable window is the vertical's job.

This shape is deliberate. With mixed durations there is no canonical slot list — "does 90
fit at 19:00? does 120?" is a question about gaps, and a fixed slot list cannot answer it.

## Permissions

| Key | Grants |
|---|---|
| `booking:create` | add participants to a reservation |
| `booking:read` | resources, reservations, availability |
| `booking:hold` | place a tentative hold |
| `booking:confirm` | confirm a held reservation |
| `booking:cancel` | cancel a reservation, or leave one |
| `booking:move` | reschedule to another slot or resource |
| `booking:complete` | start service, complete, or mark a no-show |
| `booking:manage-resources` | create, edit and deactivate resources |

`booking:move` is separate from `booking:cancel` on purpose: staff who may reschedule a
customer are not necessarily staff who may cancel and refund one. `booking/open` is
guarded by `booking:confirm` rather than a key of its own: whoever may confirm a
reservation may decide whether it is on offer.

## Entitlement

`entitlementKey: 'booking'`. Default-deny — grant it to a tenant before its operations
resolve.
