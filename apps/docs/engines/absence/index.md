# Absence engine

`@substrat-run/engine-absence` — approved absence as an **append-only entry ledger over an
opaque subject**. Balances are folds, approval is the only path onto the ledger, and the
engine deliberately knows nothing about who its subjects are, how leave accrues, or which
days count — all of which are the vertical's.

## At a glance

| | |
|---|---|
| **Package** | `@substrat-run/engine-absence` |
| **Entitlement key** | `absence` |
| **Owns** | the append-only ledger, balance-as-a-fold, the per-type balance floor, the request approval state machine, stale-request expiry |
| **Emits** | 6 events, `absence.requested` → `absence.decided` ([events](./events)) |
| **Consumes** | nothing — it is a source, not a sink |
| **Permissions** | 4 (`absence:read` · `request` · `approve` · `configure`) |
| **Status** | product seed (0.x) — surfaces change until the first vertical ships |

## What it owns

- **The ledger is append-only, always.** An accrual, a booking, a correction, a carryover,
  or a reversal is a **new entry** — never an edit, never a delete. A mistake is corrected
  by a compensating entry, so the record of what was believed when survives.
- **Balance is a pure fold.** `balanceAsOf(subject, leaveType, asOf?)` sums signed deltas
  over entries effective by that date. There is no stored counter to drift, no cache to
  invalidate, nothing to reconcile.
- **Only an approved request books.** The state machine —
  `requested → approved | rejected`, with `requested | approved → cancelled` — cannot skip,
  and the `booking` and `reversal` entry kinds are mintable **only** through
  `decideAbsence` and `cancelAbsence`. "The ledger moves only through approval" is a
  construction, not a review comment.
- **The floor is the engine's, per leave type.** A booking that would fold the balance
  below the type's floor is rejected at decision time — not by the UI. Floor `0` refuses
  overdraft; a **negative floor admits advance leave** (*förskottssemester*) with no code
  change.
- **The subject is opaque.** Every write names a `subject`: an `EntityRef` the vertical
  provides (an employee, a plannable crew resource) plus the `DataSubjectId` that keys
  crypto-shredding. The engine never dereferences the ref and **never owns a directory**.
- **Stale requests expire under a system actor.** The manifest declares an
  `absence/expire-stale` schedule: a leave still `requested` after its start date is
  cancelled by the platform sweep, attributed to
  `{ system: '@substrat-run/engine-absence' }` — never to a manager who never looked at it.

### The property worth understanding

**Dates here are calendar days, inclusive on both ends** — deliberately unlike the
[booking engine's](/engines/booking/) half-open instants. Booking allocates physical
time; absence covers human days. The `days` decimal on a request is **vertical-computed**
(a Monday–Friday request may be `5`, or `4` after excluding a red day): the engine folds
it, it never derives it. Correspondingly, `availability()` answers *"an approved absence
covers this date"* — never *"this many hours free"*. Composing that verdict with a holiday
calendar is the vertical's last mile.

## What it will not do

- **No directory.** No employee table, no names, no employment terms, no notion of who
  reports to whom. Existence checks on the subject happen in *your* operation, before the
  engine call.
- **No leave-type semantics.** The engine stores a key, a floor, and an active flag.
  Labels, statutory day counts, what *VAB* or *baja* mean, per-country divergence — all
  vertical vocabulary ([composing](./composing)).
- **No accrual formulas, no carryover caps.** Accruals and carryovers are entries you
  record; the rules that generate them are yours.
- **No calendars.** Weekends, red days, and public holidays never enter the engine.
- **No scheduling.** "Is this person double-booked on a shift" is a different seam
  (interval capacity — the booking engine, or a future scheduling engine). This engine
  answers availability *per an approved ledger*, nothing more.

## Where it came from

The ledger shape was written **vertical-first** inside the Meridian HR demo, to that
spec's own extraction plan: freeze the invariants as plain module code, and extract the
engine only when a *second consumer with a different shape* arrives. It did — field-crew
resource planning, where the subject is a plannable `resource` rather than an employee —
and the extraction moved the invariants here while Meridian kept its vocabulary and
screens. The subject-opacity line above is what made that composition possible, and it is
load-bearing: it is why the same engine serves an HR product and a route planner without
either forking it.
