# Demo Vertical — "RallyPoint" (racket-club booking)

Status: draft v0.1 · Last updated: 2026-07-18

> Companion to [booking-social.md](../../../docs/rfc/booking-social.md) (the tier split,
> locking model, and outbox seam) and [concept.md](../../callout/spec/concept.md) (the reference
> demo). Anonymization per the master plan: the feature set is derived from **the racket-club
> vendor's** public product surface (Playtomic Manager) — deliberately, so demo work seeds a
> real `engine-booking` rather than a throwaway.

## 1. What the demo must prove

`fsm` already proved the three-layer split, the star topology, and structural enforcement.
This demo must prove **new** things or it is not worth building:

1. **A second invariant shape.** `workorder` is a *state machine*; `booking` is
   **allocation against capacity over an interval**. Different primitive, same kernel.
2. **Locking is structural, not code.** Two players race for the last slot; one is rejected
   — with no lock, no `SELECT … FOR UPDATE`, no retry loop. The scope's single-writer DO
   *is* the lock. This is the most demoable property Substrat has.
3. **The engine generalizes past its first vertical.** The same `engine-booking` runs a
   padel club and a hairdresser (different vocabulary, capacity, and duration model), and
   composes with `engine-workorder` for a bike shop's drop-off + repair.
4. **The outbox is a real seam.** Club events leave via `_substrat_outbox` and feed an
   out-of-kernel consumer (the player tier), without any cross-scope read.

## 2. Shape: racket club as v1, salon as the reuse proof

**v1 demo** = "RallyPoint": a padel/tennis club — courts, open matches, memberships,
coaches. **v2 skin** = "SalongTid": a hairdresser running the *same* engine with
service-derived durations and per-stylist resources. The bike shop is a third, cheaper
proof: the existing `Handlebar` skin gains a drop-off booking, demonstrating
`booking` + `workorder` composed in one vertical.

## 3. Tenancy setup

- **Tenant = the club operator**; **scope = the venue** (a club with two locations is one
  tenant, two scopes). Demo data: **two tenants × two scopes** — RallyPoint AB (Solna +
  Nacka), Padelcenter Väst AB (Göteborg + Mölndal) — giving the cross-tenant attack demo a
  victim, matching `fsm`.
- **Critical scoping constraint** ([booking-social.md §3](../../../docs/rfc/booking-social.md)):
  a resource's *entire* calendar must live in one scope. All of a venue's courts are in
  that venue's DO. Never split one court across scopes — that reintroduces distributed
  locking and forfeits the single-writer guarantee.
- Principals: a club admin (tenant-level role), a receptionist at both venues, a
  receptionist at exactly one, a coach (sees own lessons only), and a **player** — who is
  *not* a principal but an opaque customer ref with an entity-narrowed grant (§9).

## 4. Decomposition of the club-manager feature set

| Capability | Layer | Demo scope |
|---|---|---|
| Court calendar, reservations, no double-booking | **Engine `engine-booking`** | v1, core |
| Court management (create / edit / deactivate) | **Engine** `manage-resources` + **vertical** screens | v1, admin portal |
| Club + court opening hours, closures | **Vertical** (§4.1) | v1 — weekly schedule + exceptions |
| Open matches: club-opened, player-opened, or opened later (§4.5) | **Engine** (`fillTarget`, `booking/open`) + **vertical** (ownership, level bands) | v1, **the showpiece** |
| Screen state in the URL (§4.6) | **App** | refresh and links both work |
| Slot durations (60/90/120) + start-time grid | **Vertical** | allowed durations per court + 30-min grid |
| Book a time, court assigned last (§4.2) | **Vertical** | availability aggregated across the venue |
| Court cover (indoor/covered/open) + filter (§4.3) | **Vertical** | `cover` on the court, filters narrow before the grid |
| Match participants visible; roster not (§4.4) | **Vertical** policy | published match ≠ customer list |
| Club list (all clubs, incl. unjoined) (§10.1) | **Directory** — `listScopes()` | a global query over ROOT entities, by design |
| All open matches across clubs (§10.1.1) | **Server fan-out** → global index later | matches are domain data, so scopes are asked |
| People I've played with, at this club (§10.2) | **Vertical** | the single-club shadow of a player-tier feature |
| Pricing rules by court / day / time / **duration** | **Vertical** | price-rule table + pricing hook at confirm |
| Memberships (tiers, discounts) | **Vertical** | one tier + a discount rule |
| Split payment ("pay your share") | **Engine `engine-invoicing`** | v1 — the star-topology showpiece |
| No-show → charge → debt blocks booking | **Vertical** policy over engine events | v1, stretch |
| Coaches + private lessons | **Vertical** (a resource kind) | resource kind `coach`, one lesson |
| Leagues, tournaments, classes | **Vertical**, deferred | out of v1 |
| POS / terminal sales | **Connector**, deferred | out |
| Analytics / occupancy reports | **Vertical** read models | one occupancy view |
| Staff roles & per-section permissions | **Kernel** | roles table (§9) |
| Player app, chat, level rating, "clubs near me" | **Out-of-kernel consumer** (§10) | stubbed seam only |

### 4.1 Court & venue administration (admin portal)

**Two levels of hours**, because they answer different questions:

- **Club hours** — the venue's weekly schedule (Mon–Fri 07:00–23:00, Sat–Sun 08:00–22:00).
- **Court hours** — an optional *narrowing* for one court: an outdoor court closing earlier
  in winter, or a court held for coaching 09:00–12:00.

> **Effective bookable window = club hours ∩ court hours − closures.**
> Court hours **narrow, never widen** — a court cannot be open while the venue is shut.
> Enforce that on write, or the two tables will disagree and the calendar will lie.

Hours are stored as **local wall time + the venue's IANA zone** (per
[engine-booking.md](../../../docs/engines/booking.md) D-B, local intent is vertical
territory) and materialized to instants when querying — so 07:00 stays 07:00 across a DST
boundary.

Conventions to fix **before the first migration** (append-only, so these are expensive later):

- **Past midnight** — a club open 07:00–01:00 stores `closes_at < opens_at`, meaning "next
  day". Decide the convention once; naive comparison silently truncates the late hours,
  which is exactly the padel prime-time slot.
- **Closed days** — an explicit `closed` flag beats a missing row: absence is ambiguous with
  "not configured yet".

**Closures & maintenance — two mechanisms, deliberately:**

- **Structural / recurring** (winter hours, a standing coaching block) → the hours tables.
- **Ad-hoc** (resurfacing, a private event, a burst pipe) → **an ordinary reservation** with
  an internal `party_ref` and no participants. This reuses the §6 overlap invariant exactly,
  blocks the slot for free, and shows on the club calendar with no new mechanism.
  Recommended over a parallel "blackout" table — a second way to occupy a court is a second
  thing that can disagree with the first.

**Availability stays the engine's, filtered by the vertical.** `availability()` returns raw
free intervals between reservations — left alone it would happily report 03:00 as bookable.
The vertical passes the effective window as the `from`/`to` bounds (or intersects after),
keeping the engine policy-free and consistent with D-B.

**Screens** (detail in `views.md`): courts list (name, kind, capacity, active); court detail
(hours override, allowed durations, price rules); club settings (weekly hours, closures and
holidays); calendar with blocks.

**Permissions**: court CRUD is the engine's `booking:manage-resources`; venue hours and
closures are vertical config needing their own key (`rally:manage-venue`). A new key means
it lands in the **permission-diff human checkpoint**.

### 4.2 Book a TIME, not a court

Players do not care which court they get. Asking them to pick one first is asking a
question they have no basis to answer, and it hides the thing they actually want to know —
*is 19:00 free at all?*

- **Availability is aggregated across the venue**, not per court: a start time is offered if
  *any* court can take it, and the answer carries how many can.
- **The court is chosen last, or not at all.** One court free → it is assigned silently.
  Several → the player may pick, after the time is settled, and most never will.
- **Filters narrow the pool before the time question**, never after (§4.3).

**The flow is two steps, and the split is what each one is deciding:**

| | Decides | Also carries |
|---|---|---|
| **Step 1 — when** | a start time | *filters* only: date, cover, and optionally a duration. A duration here narrows WHICH TIMES are offered; it is not yet a choice about the booking. |
| **Step 2 — what** | duration (defaults to **90**), court, and payment | the resolved price, quoted before anything is committed |

Putting duration on step 1 as a *choice* was wrong: it asked for a decision about
the booking before the player had one to make, and mixed a filter with a
commitment. Asking it twice — once as a filter, once as a decision — is fine,
because they are different questions.

Nothing is held between the steps. That is honest while payment is synchronous:
a hold exists to protect a slot across an ASYNCHRONOUS payment, so the hold and
the confirm happen together on the button, and the lost race is handled by the
409 path. The countdown the design specifies returns with the payment rail.
- Staff are the exception: the console books a *specific* court, because reception is
  looking at a grid and moving people between named courts all day.

Consequence for the engine surface: `availability()` stays per-resource — the invariant is
per-resource and must remain so. The **aggregation is the vertical's**, which is the same
split as opening hours: the engine answers about one resource, the vertical answers about a
club.

### 4.3 Court attributes and filters

A padel court is not a fungible box, and the difference that matters in Sweden is weather:

| `cover` | Means |
|---|---|
| `indoor` | fully enclosed and heated |
| `covered` | roofed but open at the sides — dry, not warm |
| `open` | open air |

`indoor` as a boolean was too coarse: "has a roof" is the question a player actually asks in
November, and it is answered by `indoor` **or** `covered`. Filters (cover, duration) narrow
the pool *before* the time grid is computed, so a player never sees a slot they filtered out.

### 4.4 What a player may see about a match

`rally:browse` is free/busy only, and the club's member roster is never readable by a
player. **An open match is the deliberate exception**: its participants are visible — name
and level — to anyone who can see the match.

That is not a hole in the privacy model, it is the point of publishing. Joining strangers
is the product; you cannot ask someone to commit 90 minutes and a payment to three
anonymous slots. The people in an open match have opted into being seen *by opting into the
match* — which is exactly the consent the club roster lacks.

The line to hold: **participants of a match you can see, yes; the club's customer list, no.**
A private booking's co-players are visible only to the people on it.

### 4.5 Three kinds of open game, distinguished by OWNERSHIP

"Open game" is not one thing, and the difference is who owns the court:

| Opened by | Owner | Who is on it at the start | Who pays |
|---|---|---|---|
| **The club** (the common case) | nobody | **nobody** — every place is on offer | whoever signs up |
| **A player, up front** | that player | the host, automatically | host + joiners, split |
| **A player, afterwards** — opening a booking they already hold | that player | whoever is already on it | as above |

The club case is the one a real venue uses most: staff put a court on offer to
fill an off-peak hour. It has **no host participant** — a club is not a player —
and therefore no portal owner and nobody to bill until someone signs up, which is
why `rally_bookings.member_id` and `rally_matches.host_member_id` are nullable.

The third case needs the engine to allow a target to be set on a reservation that
already exists (`booking/open`). `fillTarget` drives the auto-confirm, so it is
engine state: a vertical cannot open a booking up by keeping its own counter
beside the engine's and hoping they agree.

**A booking's owner is a participant.** A plain booking joins its booker to the
court — without that a booking has an empty roster, so "open my game for three
more" cannot tell that a place is already taken, and "who is playing" is blank
for the one person who certainly is.

### 4.6 Screen state belongs in the URL

Which club, which tab, which date, which slot — a refresh must land where you
were, and a link must point at something. Written with `replaceState` for
filters and `pushState` for the booking step, because that step is the one thing
here a back button should walk out of.

### 4.7 Open matches are sized in OPEN SLOTS

A padel match is four players. The variable is not "2 or 4" — it is how many places the
host is opening: **1, 2 or 3**. (Singles exist; they are a court whose capacity model says
2, not a choice the host makes in the match sheet.)

So the create flow asks *"how many spots do you need?"*, the card reads *"2 platser
lediga"*, and `fillTarget` is derived rather than picked.

## 5. `engine-booking`

The primitive ([booking-social.md §2](../../../docs/rfc/booking-social.md)):

> a **resource** held over a **time interval**, with the invariant that concurrent
> allocations never exceed the resource's **capacity** over any overlapping interval.

- **Tables**: `booking_resources`, `booking_reservations`, `booking_participants`.
- **Invariants (what the engine *is*)**:
  1. **No overallocation** — the sum of live allocations for a resource over any instant
     never exceeds its capacity. Exclusive booking is capacity = 1.
  2. State machine, no skips:
     `held → confirmed → in_service → completed`, plus `held → expired`,
     `confirmed → cancelled | no_show`.
  3. `held` carries a mandatory `expiresAt` — a hold is never permanent.
  4. Append-only participants, bound to a non-terminal reservation.
  5. Every mutation emits a fat event; every operation checks a permission.
- **Permissions**: `booking:create|read|hold|confirm|cancel|complete|manage-resources`.
- **Emits**: `booking.resource-created|held|confirmed|expired|cancelled|started|completed|no-show`
  (`piiClass: none`, carrying `participantCount`) and `booking.participant-joined|left`
  (`pseudonymous`, keyed to that one data subject). See engine-booking.md **D-C** — a roster
  cannot ride an aggregate event, because the envelope permits one `subjectId`.
- **Consumes**: nothing (leaf producer).
- **Vertical extension points**: resource `kind` vocabulary (court / stylist / bench),
  duration model (fixed slot vs service-derived), capacity, the **pricing hook** consulted
  at confirm, and the **fill policy** (§7).

### Why `booking` is its own engine, not part of `workorder`

The slot-allocation invariant is genuinely distinct from a work-order lifecycle, and the
bike shop wants **both** composed (drop-off = booking, repair = workorder). Folding
booking into `workorder` would force every reservation domain to carry work-order
vocabulary it has no use for. Star topology holds: they never import each other.

## 6. Locking & consistency — the demo's sharpest moment

A scope = one DO = one serialization domain. Every booking touching a court flows through
that venue's single writer, so "check free → write" is one uninterleaved transaction.
**There is no race to lock against.** The scenario test fires two concurrent
`confirm` calls at the last free slot; one wins, one gets `SlotUnavailable` — with no
locking code anywhere in the engine.

- **Soft holds** = the `held` state + TTL. Expiry is **lazy** (a `held` row with
  `expiresAt < now` counts as free on the next attempt); a DO alarm is only added if live
  UI release is wanted.
- **Availability views** are eventually-consistent read models. The DO stays the arbiter:
  race for a slot the view showed free and the loser gets "just taken."

## 7. The open-match mechanic (the showpiece)

Worth building because it exercises the engine's hardest corner and is unlike anything in
`fsm`. Per the vendor's public behaviour:

- A player creates an open match; **the court is not reserved immediately**. The
  reservation sits in `held` with a fill target (2 for a single court, 4 for a double) and
  a deadline.
- Other players join; each pays their share. On reaching the target → **auto-confirm**.
  On hitting the deadline unfilled → **expire and release**, participants refunded.
- Level range: derived from the first joiner (a −0.25 / +0.75 band). A player outside the
  band may *request* a spot; existing participants must unanimously accept. **Vertical
  policy** — the engine only knows fill target and deadline.
- Cancellation: while unfilled, any participant may leave freely; once full, up to 24h
  before start. Both are **vertical policy** enforced over engine operations.
- No-show: reported by other participants → charged the court share → a debt that blocks
  further booking. Vertical policy composing `engine-invoicing`.

This maps cleanly: **`held` + fill-condition + deadline is exactly the conditional
confirmation the engine already needs for payment holds.** One mechanism, two products.

## 8. Composition with `engine-invoicing`

Split payment is the star-topology showpiece: `booking.confirmed` carries the participant
list and the resolved price (fat payload — the consumer never needs a cross-module read);
the vertical composes invoicing's in-scope functions in the *same transaction* to raise
one charge per participant. No-show charges and refunds ride the same path.

## 9. Roles & permissions (human checkpoint preview)

| Role | Holds |
|---|---|
| `club-admin` | all `booking:*`, pricing, memberships, reports |
| `receptionist` | `booking:create|read|hold|confirm|cancel`, no `manage-resources` |
| `coach` | `booking:read` — **the whole venue calendar**, not just their own lessons |
| *player* | **no role** — an entity-narrowed `CapabilityGrant` over their own reservations |

The player row is the important one: a consumer is **not** a principal with a role
([kernel-design.md §4.3](../../../docs/architecture/kernel-design.md)). This reuses the portal
shape `fsm` already proves — no new mechanism.

**The coach grant is deliberately broad — reviewed and accepted (2026-07-18).** A coach
holds plain `booking:read`, which reads the venue's *entire* calendar: every court, every
slot, and who booked it. It is **not** narrowed to their own lessons. Narrowing would need
an entity grant minted per coach at runtime (a console concern), and for a club of this
size the calendar is effectively public to staff anyway. Two consequences a future reader
should not have to rediscover:

- a coach can see **member names against bookings**, so the role is not free of personal
  data even though it grants no writes;
- if a club ever runs independent coaches who must not see each other's business, this
  role is wrong for them and needs the entity-narrowed grant instead.

## 10. The player / social tier — explicitly out of the vertical

The cross-club player identity, connections, small groups, and level rating are **not part
of this vertical** and cannot be: they are keyed to a global player identity owned by no
tenant ([booking-social.md §1, §4](../../../docs/rfc/booking-social.md)). The demo ships
only the **seam**:

- `booking.participant-joined` emitted per player, carrying the **global player ref** as a
  shreddable `DataSubjectId`, correlated to `booking.completed` on `reservationId`;
- one thin consumer draining `_substrat_outbox` into a "my bookings across clubs" read
  model — proving the event→projection loop without building the social network;
- a **match join-link** (capacity-bounded, expiring) to show the privacy-clean add.

Out of scope: global player search, feed fanout, contact matching.

### 10.1 Global queries are allowed — over the DIRECTORY, not over scopes

The rule is **not** "no global queries". It is "a scope may not read another
scope's data", and those are different things:

| Layer | Holds | Global query? |
|---|---|---|
| **Directory** | tenant + scope records: id, slug, name, kind, status, jurisdiction | **Yes — that is its job.** `listTenants()` / `listScopes()` exist precisely so callers can enumerate; §3.2 calls it "the ONLY complete inventory of tenants and scopes". |
| **Scope DB** | domain data: courts, bookings, members, prices | **No.** Never, from anywhere. |

So *"list all clubs"* is a **directory** question, answered by one query. *"List
all clubs with three indoor courts"* is a **domain** question, because the court
count lives inside each scope, and no amount of it being a read makes it one.

**Read-vs-write is not the distinction.** The isolation is not about contention;
it is about three things a read breaks just as thoroughly:

- **blast radius** — cross-scope read code is exactly where a tenancy leak lives;
- **migration independence** — scopes migrate separately, so a query spanning
  them must cope with N schema versions at once;
- **jurisdiction** — a scope carries one, and pulling its rows into a global
  index can move data across a residency boundary. That is a legal constraint,
  not a performance one.

**The consequence for a listing.** If a club listing wants attributes — location,
amenities, court count, a photo — the answer is not to ask every club at query
time. It is that those are **listing attributes**, and belong on the listing:
promoted to the scope record, or to a marketplace projection fed by the outbox.
That is the "global index = adapter" the design already names, and it is what
makes *"clubs near me"* one indexed query instead of a fan-out.

This also settles **decision 0**: venue coordinates belong on the **directory
record**, not inside the scope's database. They describe the club as a *listing*,
not as an operation.

### 10.1.1 What still fans out, and why

Open-match search remains a fan-out, because a match **is** domain data —
per-scope, live, and not a listing attribute. Its limits stand:

- **Fan-out is O(venues).** Fine for a demo with three, wrong at a thousand — at which point
  it becomes a real index fed by the outbox, not a loop.
- **It respects permissions per scope**: a venue the caller cannot reach contributes
  nothing. For *matches* that is correct — you cannot join what you cannot reach. For the
  **club list it was a bug**, and the reason that list now comes from the directory:
  filtering discovery by access means a player can never find a club they have not joined,
  which is precisely backwards for a marketplace. **Discovery and access are separate
  questions**, and `/api/my-venues` answers the second one.

### 10.2 "People I've played with" — the single-club shadow

The real feature is cross-club and belongs to the player tier. But the *useful 80%* is
answerable inside one club: **the people you have shared a reservation with here**, derived
from participants of matches you were on.

It is privacy-defensible on exactly the same ground as §4.4 — you played together — and it
needs no new mechanism. It is explicitly **not** the cross-club connection graph, and
building it must not be mistaken for having built that: the moment a second club is
involved, only the player tier can answer.

## 11. Scenario (testrun outline)

1. Seed two tenants × two venues, courts, **opening hours**, price rules, one membership tier.
2. **Venue admin**: edit club hours and a court's narrowing override; a booking outside the
   effective window is rejected by the vertical before it reaches the engine.
3. Receptionist books a court (90 min) → `held` → `confirmed`; invoice raised.
4. **Concurrency**: two confirms race the last slot → one `SlotUnavailable`.
5. **Hold expiry**: a `held` reservation passes its deadline → slot free again.
6. **Maintenance block** (internal reservation) prevents booking that court, via the same
   overlap invariant.
7. **Open match**: create unfilled → 3 join → auto-confirm on the 4th, split charges.
8. **Unfilled open match** hits deadline → expire + refund.
9. Cancellation inside/outside the 24h window → policy accepts/rejects.
10. **Cross-tenant attack** from vertical code → fails at the boundary.
11. `booking.completed` + its `participant-joined` events land in the outbox consumer's
    cross-club read model.

## 12. Open decisions

0. ~~**Venue coordinates.**~~ **Settled (§10.1):** they belong on the **directory record**,
   because they describe the club as a listing rather than as an operation. Still to build:
   the field itself, and a map on top of it.

1. **Capacity model** — first-class quantity-against-capacity (needed for 4-player matches
   and classes) vs boolean-exclusive. Leaning first-class; exclusive is capacity = 1.
   Retrofitting later is a frozen-payload `schemaVersion` bump.
2. **Where the fill policy lives** — engine (fill target + deadline, generic) vs vertical
   (level bands, unanimity). Proposed split above; confirm before scaffolding.
3. **Recurring bookings** (a weekly 19:00 court) — common in this domain, and it stresses
   the interval model. In or out of v1?
4. **Timezone/DST handling** for intervals — must be decided before the first migration.
5. Whether the salon skin ships in this milestone or follows as the reuse proof.
