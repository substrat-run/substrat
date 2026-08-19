# RallyPoint — design briefs

Status: draft v0.1 · Last updated: 2026-07-18

> Two self-contained prompts for a design tool. Each carries its own product context so it
> can be pasted standalone. Companion to [concept.md](concept.md) (the domain) and
> [engine-booking.md](../../../docs/engines/booking.md) (states and invariants).

## Why two surfaces

Same API, two audiences, two devices, two densities — mirroring the shop demo's
storefront/back-office split (CLAUDE.md: *"the split is chrome and audience, never a second
source of truth"*).

| | **Player app** | **Club console** |
|---|---|---|
| Device | mobile-first, one-handed | desktop-first, 1440px+ |
| Context | at the court, in a WhatsApp thread, on the move | a reception desk, 8 hours a day |
| Frequency | a few minutes, a few times a week | continuously, all day |
| Register | consumer, social, energetic | operational workhorse: dense, fast, calm |
| Success | booked a game in under 30 seconds | took a phone booking without looking away |

**Shared brand, divergent chrome.** One set of design tokens (colour, type, spacing); the
player app spends them on expressiveness, the console on density and legibility.

---

## Prompt 1 — Player app (mobile)

```
Design a mobile-first web app for "RallyPoint", a padel and tennis court booking app.
Players use it to book courts at any of thousands of independent clubs, and to find people
to play with. Think one-handed use, standing at a court or on the move.

AUDIENCE & TONE
Recreational padel players, 25–50. The product is social and energetic but never childish —
this is a real transaction (people are paying and committing time). Confidence and speed
over decoration. Sporty, modern, high-contrast. Support light and dark.

CORE JOBS
1. Find clubs near me and see what's actually free.
2. Book a court for a chosen date, time, and duration (60 / 90 / 120 minutes).
3. Create an "open match" others can join, or join someone else's.
4. Pay my share, and manage/cancel my bookings.
5. Keep the people I've played with, and organise a small regular group.

SCREENS TO DESIGN
1. Discover — clubs near me (map/list toggle), distance, next free slot, price from.
2. Club detail — courts, an availability strip for a chosen day, indoor/outdoor, amenities.
3. Slot picker — pick date, start time, and duration. THE critical interaction: durations
   are 60/90/120 and not every duration fits every gap, so the UI must show which durations
   are actually available at a given start time without a dead-end tap.
4. Booking confirmation & payment — price, duration, court, cancellation terms.
5. Open matches — browse joinable matches: club, time, spots left (e.g. 3/4), skill level
   band, price per player.
6. Match detail — participants with avatars and levels, empty slots, your share, join/leave.
7. My bookings — upcoming and past, with cancel affordances.
8. Profile — level/rating, play history, connections, groups.
9. Join-via-link landing — someone tapped a match link shared in WhatsApp. Must work for a
   logged-out first-time user: show the match, then sign-in/sign-up, then joined.

CRITICAL STATES (these are what make or break this product — design them explicitly)
- Slot just taken: the user tapped a slot that someone else confirmed a second earlier.
  Must feel graceful and immediately offer nearby alternatives, never a dead error.
- Hold countdown: a reservation is held for ~10 minutes pending payment. Show remaining
  time with urgency but not panic; design the expired state too.
- Open match filling: 2/4 joined. Show momentum and who's in.
- Level band: matches accept a skill range. Show clearly whether the user is inside it; if
  outside, they may REQUEST a spot, which all current players must approve — design the
  pending-approval and declined states.
- Split payment: "your share is 120 kr of 480 kr" — make the split obvious and fair-feeling.
- Cancellation window: free to leave while the match is unfilled; locked within 24h of a
  full match. The transition between these must be legible BEFORE the user commits.
- Blocked by debt: an unpaid no-show fee blocks new bookings. Firm, not humiliating.
- Empty states: no clubs nearby, no open matches, no connections yet.

CONSTRAINTS
- Thumb-reachable primary actions; bottom navigation; sheet-style modals.
- Minimum 44px tap targets; readable outdoors in sunlight (high contrast).
- Prices in SEK. 24-hour time. Metric distances.
- Accessible: WCAG AA contrast, never colour alone to convey state.

DELIVERABLE
High-fidelity screens for the flows above, plus a small component set: slot chip, duration
selector, match card, participant row, countdown, price-split block.
```

---

## Prompt 2 — Club console (desktop)

```
Design a desktop web console for "RallyPoint Manager", the staff-facing side of a padel and
tennis club booking platform. Club receptionists and managers run their entire day in it.
Optimise for density, speed, and long continuous use — this is a workhorse tool, closer to
a scheduling/ops product than a consumer app.

AUDIENCE & TONE
Club reception staff and owners. Often taking a booking on the phone while a customer waits
at the desk. Calm, dense, unambiguous. Zero decoration that costs a row of data. The
aesthetic reference is a good calendar or ops dashboard, not a marketing site. Light and
dark, 1440px+ primary, degrade gracefully to 1024px.

CORE JOBS
1. See today at a glance and take a booking in seconds, mid-phone-call.
2. Manage courts: create, edit, deactivate, set per-court hours and allowed durations.
3. Set club opening hours, closures, and holidays.
4. Set pricing rules by court, day, time, and duration.
5. Handle exceptions: cancellations, no-shows, blocking a court for maintenance.
6. See occupancy and revenue trends.

SCREENS TO DESIGN
1. Calendar (THE core screen, where staff live all day) — a resource grid: courts as
   columns, time as rows, one day at a time, with a visible "now" line. Must support
   drag-to-create a booking and click-to-inspect. Consider week and multi-court views.
2. Booking drawer/panel — create or edit without leaving the calendar: customer, court,
   start, duration, price (auto-applied from rules, overridable), payment status.
3. Courts list + court detail — name, indoor/outdoor, capacity, active state, hours
   override, allowed durations, price rules.
4. Club settings — weekly opening hours per day, plus closures and holiday exceptions.
5. Pricing rules — a rule table keyed on court / day / time / duration, with peak and
   off-peak. Must make rule precedence and overlaps visible.
6. Members — membership tiers and their discounts.
7. Reports — court occupancy over time, off-peak gaps, cancellations, revenue.
8. Staff & roles — who can view vs edit which sections.

CRITICAL STATES (the calendar must distinguish all of these at a glance)
- Confirmed booking vs HELD (awaiting payment, with a countdown) — visually distinct.
- Open match still filling: show 2/4 joined, so staff know it may yet collapse.
- Maintenance block: an internal reservation, clearly not a paying customer.
- Outside opening hours: greyed and not bookable.
- Court inactive/closed for the season.
- Past time dimmed; the current time marked.
- Double-booking rejected: a staff member tries to place a booking where one was just
  taken. Show a clear, fast, non-destructive rejection that doesn't lose typed input.
- A booking that straddles a price boundary (peak/off-peak) — show the resolved price.

CONSTRAINTS
- Information density is a feature. Many bookings per screen without visual noise.
- Keyboard-first: shortcuts for new booking, search customer, jump to date.
- Never lose typed input on an error.
- Colour-code state, but never colour alone — staff may be colour-blind and the calendar is
  entirely state-coded.
- Prices in SEK; 24-hour time; Monday-first weeks.
- Accessible: WCAG AA.

DELIVERABLE
High-fidelity screens for the above, plus components: calendar cell states, booking drawer,
rule-table row, court card, occupancy chart, and an empty/quiet-day calendar.
```

---

---

## Round 2 — what the first handover did not cover

Round 1 (`spec/design/`) is complete for a **single club**. Building against it
surfaced four gaps. Note for sequencing: these screens look the same whether the
social data lives in a player tier or elsewhere, so they are safe to design now —
what is undecided is where the data comes from, not what the screen is.

```
Design four additions to RallyPoint, a padel/tennis booking platform. An existing
high-fidelity design system is in place — match it exactly. Tokens: ink #14171A,
lime accent #D7F34F (always with ink text), success #256B3E on #EDF6D2, urgency
amber #C2510F on #FDF6EE, danger #A33328 on #F9ECEA, page #F4F4F0, surface #FFF,
borders #E2E3DC / #D8DAD2. Archivo (800 for display, tight tracking), IBM Plex
Mono 500/600 for EVERY time, price, level number and countdown. Radii 16/13/12/7,
99px pills. Borders over shadows. Selected = 2px ink border + lime fill. Disabled
= dashed border + reason text. SEK, 24-hour time, Monday-first. Skill levels are
0–7 with one decimal ("3.4"), bands as ranges ("2.5–4.0"). WCAG AA; state never
by colour alone. Mobile 402×874 with 44px minimum targets; desktop 1440px+.

1. CONNECTIONS — "players I've played with" (mobile)
   The list accumulates automatically from matches actually played together; it
   is NOT a friend-request directory and there is no global player search. Design:
   the list (avatar, name, level chip, "played together ×3", last played), a
   just-played prompt offering to keep the people from a finished match, an empty
   state that explains people land here by playing rather than by searching, and
   the per-person view (shared history, "invite to a match").
   Constraint: a connection is a social edge, NOT data access. Being connected
   never reveals the other person's other bookings. Do not design anything that
   implies it does.

2. INVITE / SHARE — the sending side (mobile)
   Round 1 designed the receiving side (1m, logged-out join). Design the sending
   side: a share sheet for an open match (copy link, QR for the person standing
   next to you, WhatsApp/Messages hand-off), the QR display screen, an invite-by-
   phone/email form, and the states after sending — sent, accepted, declined.
   Constraints, which are product rules and not implementation detail:
   - invites are ACCEPT-REQUIRED; the edge forms only when they accept;
   - a non-member and a decline must look identical to the sender (no
     enumeration — the UI must not reveal whether someone is already a user);
   - the QR/link is capacity-bounded and expiring: design "this link is full" and
     "this link has expired".

3. GROUPS — the small regular group (mobile)
   A group is 4–8 people who play together regularly, and it belongs to the
   PLAYERS, not to any club — it can book at any club. Design: the group list,
   group detail (members, next session, recent sessions), create-a-group, and the
   "find a slot that works for the four of us" flow, including the case where no
   common slot exists.

4. MULTI-CLUB (both surfaces)
   A player may belong to several clubs; a manager may run several venues. Design:
   the club switcher on mobile and the venue switcher in the console, a player's
   "my clubs" view, the state where a player opens a club they do NOT belong to
   (joining is per club, not a global flag), and — for the console — whether a
   multi-venue manager gets a cross-venue overview or only a switcher. That last
   one is an open question worth a recommendation.

Also useful: adding a named co-player to an ordinary booking (not an open match) —
who can be added, and what the other person sees.

DELIVERABLE: high-fidelity screens plus the component additions (connection row,
invite state chips, QR card, group tile, club switcher).
```

## Notes for whoever runs these

- **Design the calendar first.** The console lives or dies on that one screen; everything
  else is CRUD around it.
- **The state lists are the point.** Generic booking UIs fail on hold countdowns, partially
  filled matches, and the lost race — not on the happy path.
- The player app's **join-via-link** screen is the growth surface (matches get shared into
  WhatsApp groups), so it must work beautifully for a logged-out stranger.
- Durations (60/90/120) plus a start-time grid mean **availability is not a uniform slot
  list** — both surfaces must handle "90 fits here but 120 doesn't."
