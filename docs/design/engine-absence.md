# `engine-absence` — the approved-absence ledger

Status: draft v0.1 · Last updated: 2026-08-14

> Surface sketch for the absence engine, extracted from Meridian per the plan its spec
> already carries. Companion to
> [demos/meridian/spec/concept.md §5–5.1](../../demos/meridian/spec/concept.md) (the
> seeding vertical and the invariant surface, quoted throughout),
> [master-plan.md §3](../master-plan.md) (engines are *extracted, not designed*), and
> issue [#634](https://github.com/substrat-run/substrat/issues/634) (consumer #2:
> Egeryds resource planning over the Rutt surface). The extraction template is
> `engine-protocol` out of Callout — including the one-time R5 data-handoff migration
> (`demos/callout/src/migrations.ts`, `0003-protocols-to-engine`).
>
> **Scope guard, stated once:** this engine answers *"is this subject covered by an
> approved absence on this date, per an append-only ledger"*. It is **not** the
> scheduling engine — shift/rota planning, double-booking, and working-time invariants
> are a different seam (`engine-booking` owns interval capacity; a future scheduling
> engine owns rotas). Conflating them is how both stay unbuilt (#634).

## 0. Settled decisions

### D-A: the entry ledger is engine-private — no kernel primitive

Meridian §5 left an open question for the second consumer: the generic
append-only-entries-against-a-ref shape *smells kernel* (a contract like
documents/timeline), while accrual, approval, and floors are clearly engine. Settled:
**engine**, for v0 and until proven otherwise.

- The master plan calls building shared machinery before a consumer exists *unconsumed
  generality* — the thing §3 exists to avoid. A kernel ledger primitive would need its
  own contract surface, permission story, and migration story, all speculative.
- The valuable invariants are the domain ones (only an approved request books, floors
  rejected by the engine, corrections are compensating entries). Append-only-ness alone
  is a discipline one engine keeps in its private tables — `engine-workorder` already
  does exactly that for `workorder_time_entries`, unassisted.
- If a *non-absence* consumer ever wants the raw ledger shape, extracting a kernel
  primitive **from** this engine is the normal path — the same doctrine, one level down.

The cheap insurance: the entry row stays honestly generic (opaque subject ref, entry
kind, signed delta, effective date). Absence policy lives in the operations and the
adjacent tables, never entangled into the entry row.

### D-B: the subject is an opaque `EntityRef` + a vertical-supplied `DataSubjectId`

The engine **never owns a directory** (Meridian §5.1's line, drawn before the code
moves). Every write takes a `subject`:

```ts
subject: {
  ref: EntityRef,                 // { entityType, entityId } — the vertical's noun
  dataSubjectId: DataSubjectId,   // keys crypto-shredding for every event emitted
}
```

- **Meridian** supplies `{ entityType: 'employee', entityId }` from `hr_employees`.
- **Egeryds** supplies `{ entityType: 'resource', entityId }` from `vertical_resource` —
  a *plannable unit, not an identity* (one human is two resources; some resources have
  no login). The resource stays the planning noun; the principal stays the human; the
  absence hangs on the ref the vertical hands the engine.

Consequences:

- **Existence is the vertical's problem.** The engine cannot dereference the ref, so it
  never checks the subject exists (Meridian's `getEmployee` guard stays in Meridian's
  operation, before the engine call). Same posture as `engine-workorder`'s
  `facility`/`customer` refs.
- **`dataSubjectId` is stored on the request and on every entry**, so a later
  transition (decide, cancel, expire) can emit `piiClass: 'pseudonymous'` events keyed
  to the right subject without the caller re-supplying it. A resource with no login is
  still usually a person; the vertical decides what the id shreds to.
- Per-entity permission checks (`ctx.check(perm, subjectRef)`) carry the self-service
  walk: an employee reaches their *own* requests through an entity-narrowed grant,
  holding no role — Meridian's existing pattern, unchanged.

### D-C: the availability read returns coverage, not the planner's whole answer

New surface, designed for consumer #2 (Meridian never needed "who is out Monday"):

```ts
availability(ctx, { subject, from, to })    // inclusive date range
  → { days: { date, leaveTypeKey, requestId }[], requests: AbsenceRequest[] }
```

Every calendar day in an **approved** request's inclusive `[start_date, end_date]` is
reported as covered. The engine deliberately does **not** know weekends, red days, or
holiday calendars — those stay vertical (Meridian §5's country-divergence table; VAB is
Swedish law, not an engine concept). "Is Hugo actually unavailable Monday?" is the
vertical composing this verdict with its own holiday calendar. Stated honestly: the
verdict is *"an approved absence covers this date"*, never *"this many hours free"*.

Dates are **calendar days, inclusive** — absence is day-shaped (Meridian's model:
`start_date`, `end_date`, decimal `days`). This is deliberately unlike
`engine-booking`'s half-open instants: booking allocates physical time, absence covers
human days. The `days` decimal is **vertical-computed** (a Mon–Fri request may be `5`
or, excluding a red day, `4`) — the engine folds it, it does not derive it.

### D-D: leave-type *policy* rows are engine-owned; vocabulary stays vertical

The `protocol_templates` precedent: the engine owns a small registration table so its
invariants have something to bind to, while all meaning stays with the vertical.

`absence_leave_types` carries **key, floor, active** — nothing else. Display names,
VAB/karensavdrag semantics, accrual formulas, carryover caps, and per-country rules are
vertical tables and vertical code, forever (Meridian §5's "what stays vertical" list is
this engine's non-goals list).

`floor` generalizes Meridian's hardcoded `0`: a booking that would take the fold below
the type's floor is rejected by the engine, not the UI. A negative floor is how a
vertical models *förskottssemester* (advance vacation) without touching engine code.

### D-E: cancelling an approved absence is a named transition with a compensating entry

Meridian only ever cancels `requested` rows (the expiry sweep). The planning-led
consumer needs the other arrow — "Hugo came back Wednesday" — and the ledger answer is
already dictated by the append-only invariant: `cancelAbsence` on an **approved**
request writes a **compensating reversal entry** (same magnitude, opposite sign) and
moves the request to `cancelled`, in one transaction. Never an edit, never a delete.
(Partial returns — cancelled from Wednesday only — are v0-deferred; the vertical can
model them today as a manual `correction` entry, open question 2.)

## 1. Tables

```sql
absence_leave_types (
  key             TEXT PRIMARY KEY,     -- vertical vocabulary: 'vacation' | 'sick' | 'vab'
  floor           TEXT NOT NULL DEFAULT '0',   -- decimal; balance may not fold below this
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
)

absence_ledger (                        -- APPEND-ONLY. No UPDATE. No DELETE. Ever.
  id              TEXT PRIMARY KEY,     -- ulid()
  subject_type    TEXT NOT NULL,        -- opaque ref, stored as the pair (D-B)
  subject_id      TEXT NOT NULL,
  data_subject_id TEXT NOT NULL,        -- keys erasure for the events (D-B)
  leave_type_key  TEXT NOT NULL,
  entry_kind      TEXT NOT NULL CHECK (entry_kind IN
                    ('accrual','booking','correction','carryover','reversal')),
  delta           TEXT NOT NULL,        -- signed decimal (addDecimal/compareDecimal)
  effective_date  TEXT NOT NULL,        -- the date the entry counts from (balance-as-of)
  request_id      TEXT,                 -- set on 'booking' and 'reversal' entries
  note            TEXT,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL
)

absence_requests (
  id              TEXT PRIMARY KEY,     -- ulid()
  subject_type    TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  data_subject_id TEXT NOT NULL,
  leave_type_key  TEXT NOT NULL,
  start_date      TEXT NOT NULL,        -- calendar date, inclusive (D-C)
  end_date        TEXT NOT NULL,        -- calendar date, inclusive
  days            TEXT NOT NULL,        -- positive decimal, vertical-computed (D-C)
  status          TEXT NOT NULL CHECK (status IN
                    ('requested','approved','rejected','cancelled')),
  note            TEXT,
  decided_by      TEXT,
  decided_at      TEXT,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL
)
```

## 2. The invariants (Meridian §5, now engine-enforced)

- The **ledger is append-only** — accrual, booking, correction, carryover, reversal are
  new entries, never edits. A mistake is corrected by a compensating entry.
- **Balance is a pure fold**: `balanceAsOf(subject, leaveTypeKey, asOf)` sums `delta`
  over entries with `effective_date <= asOf`. No stored mutable counter exists.
- **No fold below the floor** — a booking that would breach the leave type's floor is
  rejected by the engine (D-D), not by UI.
- **Only the booking of an approved request touches the ledger**; only the reversal of
  a cancelled-after-approval request touches it again (D-E).
- **Every mutation emits a fat event; every operation checks a permission.**

## 3. State machine

```
requested ──approve──▶ approved ──cancel──▶ cancelled   (+ reversal entry, D-E)
    │
    ├──reject──▶ rejected
    └──cancel/expire──▶ cancelled                        (no ledger touch)
```

- No skips: only a `requested` row can be decided; only `requested` or `approved` can
  be cancelled.
- **Expiry** is #383's date-triggered rule, engine-shipped: a request still `requested`
  past its `start_date` is cancelled by the platform sweep — attributed to
  `{ system }`, never to a manager who never touched it. Idempotent and paged
  (Meridian's `expireStaleRequestsOp`, lifted as-is). The engine's manifest declares
  the schedule; the #461 CP-less path already drives it on hosted verticals.

## 4. In-scope exports (the composable surface)

Engine logic lives in plain exports; the engine's own operations are thin
(`assertAllowed(await ctx.check(PERM))` + one call), and a vertical composing these
inside its own operations does the permission check itself — same transaction, same
rule as every engine.

```ts
configureLeaveType(ctx, { key, floor?, active? })                 → LeaveType
recordEntry(ctx, { subject, leaveTypeKey,                         // accrual|correction|carryover
                   entryKind, delta, effectiveDate, note? })      → Entry
requestAbsence(ctx, { subject, leaveTypeKey,
                      startDate, endDate, days, note? })          → AbsenceRequest
decideAbsence(ctx, { requestId, decision, note? })                → { request, booking: Entry | null }
cancelAbsence(ctx, { requestId, reason? })                        → { request, reversal: Entry | null }
expireStaleRequests(ctx)                                          → { expired: number }
balanceAsOf(ctx, { subject, leaveTypeKey, asOf? })                → string  // pure fold
availability(ctx, { subject, from, to })                          → { days, requests }   // D-C
listRequests(ctx, { subject?, status? })                          → AbsenceRequest[]
listEntries(ctx, { subject, leaveTypeKey? })                      → Entry[]
```

- `recordEntry` is the one write that bypasses the request flow, restricted to
  `accrual | correction | carryover` — `booking` and `reversal` kinds are mintable only
  through `decideAbsence`/`cancelAbsence`, which is what makes "only an approved
  request touches the ledger" a construction rather than a convention.
- `decideAbsence(approve)` re-runs the floor check against the fold at decision time —
  the world may have changed since the request (engine-booking's `confirm` lesson).
- Everything absence-*policy* is absent by design: accrual formulas, carryover caps,
  holiday calendars, weekend rules, notification, and any notion of *who approves whom*
  beyond the permission key.

## 5. Permissions

`absence:read` · `absence:request` · `absence:approve` · `absence:configure`

- `absence:request` per-entity (`ctx.check(perm, subjectRef)`) is the self-service
  path: an employee/fältarbetare books leave for *their own* subject through an
  entity-narrowed grant. Withdrawing one's own `requested` row rides the same check.
- `absence:approve` covers decide, cancel-after-approval, and is the check the expiry
  sweep's system grant projects (#383/#461 machinery, nothing new).
- `absence:configure` covers leave types and direct `recordEntry` writes.
- `absence:read` per-entity carries "my balance"; unnarrowed it is the planner's and
  manager's read (`availability`, request queues).

## 6. Events (frozen once shipped)

`absence.leave-type-configured` (`piiClass: 'none'`) ·
`absence.entry-recorded` · `absence.requested` · `absence.decided` ·
`absence.cancelled` · `absence.expired`

- All subject-bearing events are `piiClass: 'pseudonymous'` with `subjectId` = the
  stored `data_subject_id` (D-B). Payloads carry the subject ref, leave-type key,
  dates/days, and entry/request ids — fat enough that no consumer ever needs a
  cross-module read.
- `absence.decided` carries `decision` and, on approval, the `booking` entry id and
  delta; `absence.cancelled` carries the `reversal` entry id when one was written.
  One transition, one event — no separate `absence.booked` (engine-booking's
  `match-played` lesson).

## 7. The two consumers

### Meridian (adoption — part of this work, not deferred)

Meridian is the test bed; leaving it vertical-first would recreate the two-ledger
divergence #634 was filed to prevent. The Callout `0003-protocols-to-engine` playbook:

1. Install the engine module alongside the vertical.
2. One-time R5 extraction-handoff migration (explicit `boundary-lint-allow R5` block):
   copy `hr_absence_ledger` → `absence_ledger` and `hr_leave_requests` →
   `absence_requests` by explicit column list (`data_subject_id` backfills from
   `employee_id`, which is what Meridian already uses as the erasure key); register the
   scope's leave-type keys + floors into `absence_leave_types`.
3. Meridian's operations swap `hr_*` SQL for the in-scope exports; `hr_leave_types`
   stays as the vocabulary table (names, country semantics), now keyed to registered
   engine types. `hr_time_entries` is **untouched** — time reporting was never absence.
4. The old `hr_absence_ledger`/`hr_leave_requests` tables are dropped in the same
   migration series once the scenario test passes against the engine.

### Egeryds (the consumer that forced this)

Subject = `vertical_resource` ids (D-B). The planning slice is read-heavy —
`availability` per resource over the route window, composed with the vertical's red-day
calendar — plus one approval flow so a fältarbetare books leave in the same app they
report work-order time (the §5.1 sentence, discharged). Their repo should record the
customer module list (sick/vacation/VAB/red days) that triggered this, so the
extraction's justifying consumer is on the record — it is currently only in #634.

## 8. Open questions

1. **Hour-granular absence** ("away Tuesday afternoon") — v0 is day-based decimals;
   hours would be a `schemaVersion` bump on payloads and a `days`-semantics question.
   Waits for a consumer that actually schedules in hours.
2. **Partial cancellation** of an approved absence (came back early) — expressible today
   as `cancelAbsence` + a manual `correction`, or a `recordEntry` correction alone;
   a named `shortenAbsence` transition waits for a real caller.
3. **Carryover automation** — year-end sweeps are vertical policy (formulas, caps), but
   the *trigger* is #383-shaped; likely a vertical-declared schedule composing
   `recordEntry`, no engine change.
4. **Overlap policy** — v0 does not reject overlapping approved requests for one
   subject (two half-day types on one date is legal in Sweden). Is a per-type overlap
   guard wanted, or is that forever vertical validation?
