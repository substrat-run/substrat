# Domain model & invariants

## The primitive

> A **resource** held over a **time interval**, with the invariant that concurrent
> allocations never exceed that resource's **capacity** over any overlapping interval.

Two axes are easy to conflate and must not be:

| Axis | Question | Padel court | Rental pool |
|---|---|---|---|
| **Resource capacity** | how many *concurrent reservations* fit? | `1` — held exclusively | `10` rackets |
| **Participant fill target** | how many *people* are on this reservation? | `4` players | `1` |

Four players on a court is **not** capacity 4. It is four participants on one reservation
that exclusively holds a capacity-1 court. Capacity above 1 is only for fungible pools; when
you care *which* unit, model separate resources.

## The state machine

```
held ──confirm──▶ confirmed ──start──▶ in_service ──complete──▶ completed
  │
  └──expire──▶ expired
```

**Declared**, at the foot of `engines/booking/src/index.ts`, and emitted to
`engines/booking/model.json` — see [Lifecycles](/concepts/lifecycle). The prose below is
written from that declaration, and `pnpm lint:model --check` is what stops this page
drifting from it.

That is the happy path; the terminal branches are wider than it, and the exact legal source
states matter:

- **cancel** → `cancelled`, from `held` **or** `confirmed`
- **complete** → `completed`, from `confirmed` **or** `in_service` (you can complete a booking
  that was never explicitly started)
- **no-show** → `no_show`, from `confirmed` **or** `in_service`

Three operations are declared `allow` rather than as edges — **`join`, `open` and `move` are
legal in `held` or `confirmed` and move nothing**. A join that fills the last place does end
with a confirmed reservation, but the move belongs to `booking/confirm`, the in-scope
function join composes; declaring `join → confirmed` would claim every join confirms.

States that consume capacity: `held` (unexpired), `confirmed`, `in_service`. The four
terminal states — `expired`, `cancelled`, `completed`, `no_show` — release it, and none of
them admits substates.

**Lazy expiry is not a declared edge.** `held → expired` is one, performed by
`booking/expire`. What is not declared is the *lapse*: a hold past its deadline reads as
`expired` through `effectiveState` with no transition having occurred. The guard therefore
runs on the stored state, and a lapsed hold is refused by `confirm` with its own
`hold_expired` reason — which tells a caller something `invalid_transition` never could.

`confirm` re-runs the allocation check rather than trusting the hold, because the hold may
have lapsed and the slot been taken since.

## Tables

| Table | Holds |
|---|---|
| `booking_resources` | id, kind (vertical vocabulary), name, `capacity`, active |
| `booking_reservations` | resource, `starts_at`/`ends_at`, state, `quantity`, `expires_at`, `fill_target`, note |
| `booking_participants` | reservation, `party_ref`, share, `joined_at`, `left_at` — append-only |

`party_ref` is a `DataSubjectId`, never a `PrincipalId`: a participant is a **customer**,
not a staff principal, and the type says so because the value keys crypto-shredding.

## The invariants

1. **No overallocation.** `SUM(quantity)` of live reservations overlapping any instant never
   exceeds `capacity`.
2. **Half-open intervals.** `starts_at < :end AND ends_at > :start` — back-to-back bookings
   do not overlap.
3. **A hold carries a deadline.** `CHECK (state != 'held' OR expires_at IS NOT NULL)`.
4. **Lazy expiry.** A lapsed hold stops counting without being swept. Correct for
   *allocation* — and a trap for *display*, which is why every reservation also carries
   `effectiveState` (below).
5. **No skipped transitions** — the state machine is declared, and the guard is derived
   from it rather than restated per operation.
6. **Participants are never deleted.**

## Instants are canonicalised

Every instant is normalised to UTC before it is stored or compared. This is load-bearing,
not hygiene: the overlap check compares instants as **strings** in SQL, and the contract
permits any offset — so `19:00+02:00` and `17:00Z` are the same moment but sort differently
as text. Normalising is the only reason lexicographic comparison equals chronological
comparison.

## `state` vs `effectiveState`

| Field | Meaning | Read by |
|---|---|---|
| `state` | as stored — a `held` row says `held` until swept | transition guards |
| `effectiveState` | `expired` once a hold's deadline passed, swept or not | every read path and UI |

Lazy expiry is right for allocation and wrong for rendering: a calendar drawing `state`
shows a held cell counting down past `0:00` forever. Guards use the stored value; anything a
person looks at uses the derived one.
