---
status: built
layer: kernel
description: Reservation and slot allocation.
---

# `engine-booking` — reservation / slot allocation

Status: **built** — the engine ships on npm

> Surface sketch for the reservation engine. Companion to
> [booking-social.md](booking-social.md) (tier split, locking model) and
> [demos/rally/spec/concept.md](../../demos/rally/spec/concept.md) (the driving vertical).
> Settles decisions 1 and 2 from the demo spec §12.

## 0. Two decisions, settled

### D-A: capacity is first-class — but it is **not** the 4-player match

A correction to [booking-social.md §2](booking-social.md), which conflated two axes. They
are different concepts and the engine needs both:

| Axis | Question | Padel | Bike shop | Rental pool |
|---|---|---|---|---|
| **Resource capacity** | how many *concurrent reservations* fit? | court = **1** | bench = 1 (3 benches = 3 resources) | 10 rackets = **10** |
| **Participant fill target** | how many *people* are on this reservation? | **4** players | 1 customer | 1 |

A padel court is **capacity 1** — it is exclusively held. The four players are
**participants on one reservation**, which drives the open-match fill condition and split
payment. Capacity > 1 is for genuinely **fungible pools** (rental equipment,
general-admission slots) where you don't care *which* unit. Where you do care which unit
(a named mechanic, a specific table), model separate resources.

Both stay first-class now: adding `quantity`/`capacity` later would be a frozen-payload
`schemaVersion` bump. Exclusive booking is `capacity = 1, quantity = 1` and costs nothing.

### D-B: the engine is **timezone-free**

The engine stores and compares **absolute instants only**. It never does timezone math.
All local-time reasoning — the venue's IANA zone, opening hours, "every Tuesday 19:00",
DST edges — is **vertical** territory, resolved to instants *before* calling the engine.

This is the right boundary because "do two bookings overlap?" is a question about physical
time, while "19:00 on Tuesdays" is a question about human intent. Keeping them apart makes
the invariant trivially correct and the engine reusable in any locale.

Vertical rules (documented here so they're decided, not discovered):

- The venue carries an **IANA zone** (`Europe/Stockholm`), never a fixed offset — offsets
  move with DST.
- Recurrence is defined in **local wall time + zone** and materialized to instants at
  generation, so a weekly 19:00 court stays at 19:00 across a DST boundary.
- Durations are **absolute** — a 90-minute booking is 90 real minutes even across a
  transition.
- **Nonexistent** local times (spring-forward gap) are rejected at input validation;
  **ambiguous** ones (fall-back repeat) resolve to the **earlier** instant, by convention.

## 1. Tables

```sql
booking_resources (
  id            TEXT PRIMARY KEY,      -- ulid()
  kind          TEXT NOT NULL,         -- vertical vocabulary: 'court' | 'stylist' | 'bench'
  name          TEXT NOT NULL,
  capacity      INTEGER NOT NULL DEFAULT 1,   -- concurrent reservations (fungible pools > 1)
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
)

booking_reservations (
  id            TEXT PRIMARY KEY,      -- ulid()
  resource_id   TEXT NOT NULL REFERENCES booking_resources(id),
  starts_at     TEXT NOT NULL,         -- instant, inclusive
  ends_at       TEXT NOT NULL,         -- instant, EXCLUSIVE (half-open)
  state         TEXT NOT NULL,         -- held|confirmed|in_service|completed|expired|cancelled|no_show
  quantity      INTEGER NOT NULL DEFAULT 1,   -- allocated against resource capacity
  expires_at    TEXT,                  -- REQUIRED when state='held'
  fill_target   INTEGER,               -- participants needed to auto-confirm (open match)
  created_at    TEXT NOT NULL
)

booking_participants (             -- append-only
  id             TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES booking_reservations(id),
  party_ref      TEXT NOT NULL,    -- OPAQUE ref (global player id / customer). Never a PrincipalId.
  share          TEXT,             -- money string via moneyOf, nullable until priced
  left_at        TEXT,             -- soft-leave; row is never deleted
  joined_at      TEXT NOT NULL
)
```

`party_ref` is deliberately opaque: the booker is a **customer, not a principal**
([kernel-design.md §4.3](kernel-design.md)), and for the padel case it carries the *global*
player id so the outbox consumer can stitch cross-club history.

## 2. The invariant, and why there is no lock

**Half-open intervals `[starts_at, ends_at)`** — a booking ending 19:00 and one starting
19:00 do **not** overlap. Stated once, relied on everywhere.

Live states consume capacity: `held` (unexpired), `confirmed`, `in_service`. Terminal
states (`expired`, `cancelled`, `no_show`, `completed`) do not.

```sql
-- allocation check, run immediately before insert/confirm
SELECT COALESCE(SUM(quantity), 0) AS allocated
FROM booking_reservations
WHERE resource_id = :resource
  AND starts_at < :new_ends AND ends_at > :new_starts        -- half-open overlap
  AND ( state IN ('confirmed','in_service')
     OR (state = 'held' AND expires_at > :now) );            -- lazy expiry
-- reject unless allocated + :new_quantity <= resource.capacity
```

This is a read-then-write with **no lock, no `SELECT … FOR UPDATE`, no retry loop** — and
it is still correct, because the scope is a single Durable Object: one serialization
domain, one writer, transactions never interleave.

> **Load-bearing consequence.** SQLite has no exclusion constraint (no Postgres GiST), so
> the guarantee comes from the *serialization domain*, not from a DB constraint. That is
> precisely why [booking-social.md §3](booking-social.md)'s scoping rule is mandatory: a
> resource's entire calendar must live in one scope. Split it and this check silently stops
> being safe.

Lazy expiry means a stale `held` row never blocks a slot — it simply stops counting once
`expires_at` passes.

### D-E: lazy expiry must not lie to a read

Lazy expiry is correct for *allocation* and wrong for *display*. The stored `state` stays
`held` until something sweeps it, so a calendar rendering `state` shows a HELD cell counting
down past 0:00 forever — which is exactly what the design handover's "releases
automatically" cell promises not to do.

So a reservation carries **both**:

| Field | Meaning | Used by |
|---|---|---|
| `state` | as stored | transition guards |
| `effectiveState` | `expired` once a hold's deadline passed, whether swept or not | every read path / UI |

`effectiveStateOf(state, expiresAt, now)` is the single definition, and `availability()`
already applied the same rule. This closes the gap without a DO alarm; an alarm is still the
answer only when something must be *pushed* on release (a notification), not merely rendered.

## 3. State machine

```
held ──confirm──▶ confirmed ──start──▶ in_service ──complete──▶ completed
 │                    │
 └──expire──▶ expired └──cancel──▶ cancelled
                      └──no-show──▶ no_show
```

- No skips. `held` **must** carry `expires_at` — a hold is never permanent.
- `confirm` re-runs the §2 check (the world may have changed since the hold).
- Auto-confirm fires when `fill_target` is reached; expiry fires when `expires_at` passes
  unfilled. **One mechanism serves both the payment hold and the open match.**

## 4. In-scope exports (the composable surface)

Engine logic lives in plain exports so verticals extend by composition, never fork.
Operations are thin: `assertAllowed(await ctx.check(PERM))` + one call below.

```ts
createResource(ctx, { kind, name, capacity? })                  → ResourceId
holdReservation(ctx, { resourceId, startsAt, endsAt,
                       quantity?, expiresAt, fillTarget? })     → ReservationId  // throws SlotUnavailable
confirmReservation(ctx, { reservationId })                      → void           // re-checks capacity
joinReservation(ctx, { reservationId, partyRef, share? })       → ParticipantId  // auto-confirms at fillTarget
leaveReservation(ctx, { reservationId, participantId })         → void
cancelReservation(ctx, { reservationId, reason? })              → void
moveReservation(ctx, { reservationId, resourceId?,
                       startsAt?, endsAt? })                    → Reservation    // throws SlotUnavailable
completeReservation(ctx, { reservationId })                     → void
markNoShow(ctx, { reservationId })                              → void
availability(ctx, { resourceId, from, to })                     → FreeInterval[] // read model
```

### D-D: `move`, not a general `updateReservation`

Rescheduling is a named transition, not a field patch. `moveReservation` changes resource
and/or interval, re-runs the allocation check **excluding itself** (so a nudge overlapping
its own old slot is legal), and keeps the reservation's identity, roster and payments — it
is emphatically not cancel-then-rebook. Passing `startsAt` alone *shifts* the booking,
preserving its duration, which is what dragging a calendar cell means.

A generic `updateReservation` was considered and rejected:

- **Engines model named transitions** (`engine-workorder` has assign/start/report/complete/
  close, no `update`). One verb per invariant keeps the guards honest.
- **Participants are an append-only log, not a patchable field.** `join`/`leave` emit
  per-subject events keyed for crypto-shredding (D-C); folding people into a PATCH would
  break that keying.
- **Payloads freeze once shipped.** `booking.moved` carrying `from`/`to` tells a consumer
  "your match moved to court 3"; a `booking.updated` diff blob would be permanent and weak.

`quantity` is deliberately **not** mutable yet — courts are capacity 1 / quantity 1, so
nothing needs it, and a later `changeQuantity` is purely additive.

`SlotUnavailable` is the typed rejection the demo's concurrency scenario asserts on.

**Not in the engine** (vertical policy): pricing rules, level bands, unanimity-to-join,
the 24h cancellation window, membership discounts, recurrence, opening hours, and
**allowed durations + start-time granularity** (§4.1). The engine knows only *fill target*
and *deadline*.

### 4.1 Variable durations and fragmentation

Padel books in 60 / 90 / 120 minutes. This needs **no engine change** — a duration is just
a different `ends_at`, and the §2 check is duration-agnostic. (Had reservations carried a
fixed `slot_number`, this would have been a schema break; it is the payoff for storing
instants.)

It is also why `availability()` returns **`FreeInterval[]`** rather than a list of bookable
slots: with mixed durations there is no canonical slot list, so the vertical must ask "at
19:00, does 60 fit? 90? 120?" against free intervals.

The **vertical** owns the resulting product concern: mixed durations at arbitrary start
times strand unbookable gaps (an 18:00–19:30 booking then a 60-min at 19:30 can leave a
dead 30 minutes). Constrain **start-time granularity** (e.g. a 30-minute grid) alongside
allowed durations so the calendar stays tileable. Allowed durations may vary by resource
and time of day (peak courts 90-only). Consequently **pricing is keyed on duration**, not
derived from it — a 90-minute peak slot is not necessarily 1.5× the 60-minute price, so
the pricing hook takes `(resource, day, time, duration)`.

## 5. Permissions

`booking:create` · `booking:read` · `booking:hold` · `booking:confirm` · `booking:cancel` ·
`booking:move` · `booking:complete` · `booking:manage-resources`

`booking:move` is separate from `booking:cancel` on purpose: reception staff who may
reschedule are not necessarily staff who may cancel and refund.

Per-entity checks (`ctx.check(perm, entityRef)`) carry the portal walk: a player reaches
their own reservation through an entity-narrowed grant, holding **no role**.

## 6. Events (frozen once shipped)

`booking.resource-created` · `booking.held` · `booking.confirmed` · `booking.expired` ·
`booking.cancelled` · `booking.moved` · `booking.started` · `booking.completed` ·
`booking.no-show` · `booking.participant-joined` · `booking.participant-left`

### D-C: aggregate events carry no participant identities

Implementation surfaced a real collision between three platform rules. Fat events are
required; a padel match has four participants; and the event envelope permits exactly **one**
`subjectId`, which is mandatory whenever `piiClass !== 'none'` because crypto-shredding must
be able to key the erasure ([contracts/events.ts](../../packages/contracts/src/events.ts)).
A four-player roster on one event cannot be keyed to one subject. The envelope has no plural.

The split that resolves it — and which is better privacy design than what it replaced:

| Event | `piiClass` | Carries |
|---|---|---|
| `participant-joined` / `-left` | `pseudonymous`, `subjectId` = that party | the one `partyRef` + share |
| every reservation lifecycle event | `none` | resource, interval, quantity, **participantCount** |

Consequences, all of them wanted:

- **The club's business record survives an erasure.** "Court 1 was booked 17:00–18:30 and
  completed" names nobody, so it is retained as a legitimate business record while the
  personal link is shredded with the per-participant events.
- **Each pseudonymous fact is individually shreddable**, keyed to exactly the subject it
  concerns — which is what the envelope was asking for all along.
- **`partyRef` is therefore a `DataSubjectId`** (ULID), not a free string. Participants are
  people; the type now says so.
- A projection consumer reconstructs the roster by correlating `participant-joined` /
  `-left` with the lifecycle event on `reservationId`. That is ordinary stream processing
  over one module's own events, **not** a cross-module read — the fat-event rule is intact.
- Split invoicing is unaffected: the vertical composes invoicing's in-scope functions in the
  **same transaction**, where it already holds the roster. It never needed the event.

`booking.match-played` is **not** emitted. `booking.completed` is the same fact, and one
transition should not produce two events; a vertical wanting match vocabulary emits its own.

## 7. Open questions

1. **Recurring reservations** — materialize N instances up front (simple, bounded) vs a
   rule evaluated at query time (flexible, harder invariant). Leaning materialization in
   the vertical, keeping the engine per-instance.
2. **`availability()` cost** — a scan per query is fine at demo scale; a maintained free/busy
   projection may be wanted before a real club's calendar view.
3. **Buffer/turnaround time** between reservations (cleaning, next customer) — engine
   concept or vertical padding of the interval? Leaning vertical.
4. Whether `no_show` belongs in the engine at all, or is a vertical state over `completed`.
