---
status: building
layer: plan
description: Booking engine shipped; the cross-tenant social tier is not.
---

# Booking & the cross-tenant social tier

> Status: design sketch (2026-07-18). Captures a conversation converging on two
> things: a reusable **reservation/booking engine**, and the **cross-tenant
> player/social tier** that sits above it (a Playtomic-shaped padel/tennis app as
> the motivating case). Not yet a committed build — see [§9 Decisions](#9-open-decisions).
>
> Cross-refs: [master-plan.md](../master-plan.md) (D-16 identity adapter, D-18
> adapter/connector triage, D-23 tuple engine, D-30 outbox), [kernel-design.md](kernel-design.md)
> (§3.2 directory, §4.3 the three audiences, DO = consistency domain),
> [control-plane.md](control-plane.md) (§6 identity seam, `_substrat_outbox`).

## 1. The two problems, and why they scale oppositely

A court-booking app looks like one product but is two systems with **opposite
scaling shapes**, and the whole design follows from keeping them apart.

- **The club business** (courts, availability, bookings, pricing, staff, money)
  **shards by club**. A busy club does a few hundred bookings/day across a handful
  of resources — a tiny, independent workload. 5M players never land on one hot
  object because every booking targets one specific club's resource. This is the
  strongly-consistent half, and it is exactly what **scope = one DO** is for.
- **The social network** (global player identity, "players I've played with,"
  small groups, "clubs near me," ratings) **shards by nobody**. It is global,
  high-fanout, eventually consistent, and cross-tenant by nature. It is **not
  scope-shaped** and must never be a scope: one giant "all players" DO caps you at
  a single writer's throughput *and* violates the no-cross-scope-read rule.

The bridge between them is the **event outbox** (§7). Clubs are the write side;
the social tier is an eventually-consistent read/coordination side downstream of
their events. Classic CQRS, with the seam falling on the tenancy boundary.

## 2. The reservation engine (`booking`)

The booking primitive generalizes far past padel:

> a **resource** held over a **time interval**, with the invariant that concurrent
> allocations never exceed the resource's **capacity** over any overlapping interval.

Exclusive booking is capacity = 1 — a padel court is held exclusively. Capacity > 1 is for
**fungible pools** (rental rackets, general-admission slots) where you don't care which
unit; where you do care (a named stylist, a specific table), model separate resources.

**The four players in a padel match are *not* capacity** — they are **participants on one
reservation**, a separate axis that drives the open-match fill condition and split payment.
Conflating the two is the modelling error to avoid; see
[engine-booking.md §0](engine-booking.md).

| Domain | Resource | Capacity | Composes with |
|---|---|---|---|
| Padel / tennis | court | 1 (4 *participants*) | invoicing; social tier |
| Bike shop | mechanic / bench | 1 | **workorder** (the repair lifecycle) + invoicing |
| Hairdresser | stylist / chair | 1 | invoicing |
| Restaurant | table (≥ party size) | 1 per table | — |
| Clinic / rental | doctor / machine | 1 or N | workorder, invoicing |

**Engine vs vertical.** The engine owns the *slot-allocation invariant*, the
resource calendar, and the booking state machine. Vocabulary (court vs chair vs
bench), duration model (fixed slots vs service-derived vs open-ended), capacity
model, pricing, cancellation policy, and screens are **vertical** territory.

**Engine composes engine (star topology).** The bike shop is the sharp example: the
drop-off is a `booking` (reserve the bench), the repair is a `workorder` (received
→ diagnosing → repairing → done — the *existing* engine). Two engines cooperating
through a vertical, never importing each other. Padel = `booking` + social tier;
hairdresser ≈ pure `booking`.

### State machine

```
held ──confirm──▶ confirmed ──start──▶ in_service ──complete──▶ completed
  │                   │
  └──expire──▶ expired └──cancel/no-show──▶ cancelled | no_show
```

- `held` is the **soft lock**: a tentative hold while the customer pays or a match
  waits for players. Expires on TTL.
- `confirmed` onward are firm allocations against capacity.
- Additive-only evolution (per the engine rules): new inputs optional with
  behavior-preserving defaults; emitted payload fields frozen once shipped.

## 3. Locking & consistency — the payoff of DO-per-scope

**The scope boundary is the lock.** A scope = one DO = one serialization domain =
a single writer. Every booking touching a resource flows through that one DO, one
at a time, so "check free, then write" is one atomic uninterleaved transaction.
There is no race to lock against — the single-writer property *is* the lock. No
`SELECT … FOR UPDATE`, no distributed lock, no optimistic-retry loop.

**Hard constraint (scope so this holds): the DO boundary must contain the whole of
any one resource's calendar.** A club's courts live in the club's DO; a stylist's
day in the salon's DO. Splitting one resource's bookings across two DOs
reintroduces distributed locking and loses the guarantee. One resource = one writer.

This is cheap precisely because per-resource booking rates are low (hundreds/day),
so the single writer is nowhere near saturated. There is no "book any of 10,000
courts" hot path — every booking targets one specific resource's DO.

- **Soft holds** are the `held` state + a TTL. Placing/checking is race-free (same
  DO). Expiry is lazy (`held` with `expiresAt < now` counts as free on the next
  attempt) or a DO **alarm** when live UI release / notification is wanted.
- **Availability views** ("what's free Tuesday") are eventually-consistent **read
  models** — fast, possibly stale. The DO stays the arbiter: race for the last
  slot a view showed free, the DO serializes, one gets "just taken."

Net: **writes and locks live inside the scope; social and availability reads are
eventually consistent outside it.** The CQRS split lands on the locking boundary.

## 4. The three tiers

| Tier | Unit | Owns | Consistency |
|---|---|---|---|
| **Clubs** (Substrat) | scope = DO + SQLite, one per club | courts, availability, bookings, money, staff | strong, sharded by club |
| **Players** (plain DO) | one DO per player; optional one per group | profile, my-history, connections, groups, inbox, rating | per-player single-writer; history is a projection |
| **Global indexes** (adapter) | search / geo store | "clubs near me," discovery, leaderboards | eventually consistent, rebuilt from events |

**Player and group DOs are plain DOs, not Substrat scopes.** Running millions of
consumers as full kernel-managed scopes would balloon the directory (specified to
inventory *tenants*, [kernel-design.md §3.2](kernel-design.md)) and burden each with
migrations/provisioning it doesn't need. The player DO is keyed by the authhero
`sub` (§5). A "small group" is a player-tier coordination object (its own DO),
**independent of any club** — it can book at any club.

## 5. Identity (authhero)

- **One global authhero pool for players** — one identity across all clubs. This is
  the *global* `(provider, externalId)` keying, which is what players *want*, and is
  distinct from the per-tenant white-label **staff** pools ([kernel-design.md §4.3](kernel-design.md)).
  (Note: the design intends `(tenantId, provider, externalId)` keying for per-tenant
  consumer pools; the as-built table keys `(provider, externalId)` globally — correct
  for players, a gap to close for white-label consumers.)
- Inside a **club scope** a player appears as an **opaque customer ref** (the global
  player id on an `EntityRef`), never a local staff principal. Bookings are attributed
  to that ref; club staff are the scope's principals with roles. "Player sees only
  their own bookings" is the **entity-narrowed capability grant** (D-23, the portal
  shape `fsm` already demonstrates) — no new mechanism.
- **A social edge is not a data grant.** Adding a connection lets you invite them to
  a match or see availability; it never opens their booking history at any club.

### Adding players — invite, don't search

- **Primary: no lookup.** The `matchPlayed` event lists co-players as global refs;
  the player DO surfaces "you played with Anna — add her?" The shared match is the
  proof of a real relationship, so there is nothing to enumerate.
- **New player: invite, accept-required.** Resolve a *verified, hashed* email/phone
  → route an invite *to them*; the edge forms only on accept. A non-member and a
  decline look identical → no enumeration.
- **Never an open name search.** Optional global lookup is opt-in, exact-match on a
  verified identifier, rate-limited, and only ever lets you *send an invite*.

### Match-link join (the WhatsApp mechanic)

A match/open-game carries a **capacity-bounded, expiring join link** — a bearer
capability. Posting it to WhatsApp uses the group's existing social graph as the
discovery layer; the link *is* the authorization (up to capacity). It doubles as the
**onboarding on-ramp**: tap → authhero signup/login → joined, then playing seeds the
connection graph. Discipline: capacity-bound, expire, revocable.

## 6. Why the social graph stays out of the kernel

The friend/group graph is *the* thing that ends the company if it leaks, so it is
**never** kernel-resident: "keep the graph out of the kernel, build it as a
[consumer] fed by [events]" ([agent-loop-007.md](../acceptance/agent-loop-007.md)).
It lives in the player tier, fed by the outbox, unreadable by any scope.

## 7. The outbox seam — one source, three kinds of subscriber

Everything above attaches to the mechanism that already exists: **`_substrat_outbox`**,
the sanctioned way effects leave a scope ([control-plane.md](control-plane.md), D-30).
The club vertical's only job is to `ctx.emit` **fat** events *inside the booking
transaction*; subscribers drain the outbox. Applying D-18's adapter/connector triage
([master-plan.md](../master-plan.md)):

| Subscriber | D-18 bucket | Example |
|---|---|---|
| WhatsApp match-post, Swish/card payment | **connector** | third-party capability a tenant configures, in the hub |
| Player search / geo / leaderboard index | **adapter** | "search backends" are platform infra it swaps (D-18) |
| Player DOs, group DOs, friend graph | **out-of-kernel consumer** | deliberately outside the kernel (§6) |

Delivery is **at-least-once**; every event carries a ULID `eventId`; sinks **dedupe**
on it and process per-aggregate in id order (or fold commutatively). The
transactional outbox means an event exists iff the booking committed — no phantom or
lost events.

**Player → club** is the other direction: the player app *calls into* a club scope's
published operation to request a booking; the club DO arbitrates the court and stays
source of truth. Cross-DO, so a network call, never a shared read.

## 8. Demo scope

- **In:** a `booking` (reservation) **engine** + a thin **club vertical** composing
  it; a scenario test showing the **double-booking rejection** (the money moment) and
  a **held → expired** hold. Optionally compose `workorder` to demo the bike-shop
  two-engine shape.
- **Stub / sketch:** one thin consumer updating a "my bookings across clubs" read
  model, and a **match join-link** — enough to show the event→graph loop and the
  privacy-clean add. Point at where player DOs / fanout attach.
- **Out:** the millions-scale social infrastructure (global search index, feed
  fanout, contact-book matching). All privacy-plumbing, no narrative.

The small-group framing is what makes the consumer side buildable alongside the demo:
ego-centric graph (fits DO-per-player), low fanout (groups are tiny), connections
bootstrapped from matches (no global player search needed).

## 9. Open decisions

1. **What is the demo *for*?** Prove the reservation engine (lean, high-leverage) vs
   showcase a Playtomic-like product end-to-end (mostly non-Substrat). Recommend the
   first, framed as "a booking engine + a club on it + the event seam a social tier
   hangs off."
2. **Capacity model in the engine** — boolean-exclusive only, or first-class
   quantity-against-capacity (needed for the 4-player match and classes)? Leaning
   first-class; exclusive is capacity = 1.
3. **Hold expiry** — lazy vs DO-alarm. Lazy for correctness; alarm only where live UI
   release matters.
4. **Identity keying** — close the `(tenantId, provider, externalId)` gap before any
   per-tenant consumer pool rides the same seam (players are fine on global keying).
5. **Is `booking` its own engine or part of `workorder`?** Recommend its own engine:
   the slot-allocation invariant is distinct, and bike-repair wants *both*.
