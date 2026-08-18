---
description: "The six events the absence engine emits, the fat payloads that spare consumers a cross-module read, and the subject key that keeps crypto-shredding possible. Consumes nothing."
---

# Events

## Emitted

| Event | When |
|---|---|
| `absence.leave-type-configured` | a leave type's key/floor/active registered or updated |
| `absence.entry-recorded` | any ledger entry lands — accrual, correction, carryover, booking, reversal |
| `absence.requested` | a request is filed |
| `absence.decided` | a request is approved (carries the booking) or rejected |
| `absence.cancelled` | a request is withdrawn or an approved absence cancelled (carries the reversal id) |
| `absence.expired` | the schedule cancelled a request left unapproved past its start date |

Consumes nothing.

## Payload contracts

All payloads are **fat**: they carry the subject ref, the leave-type key, the ids and the
deltas a consumer needs, so no consumer ever reads back across the module boundary.

- `absence.entry-recorded` — `{ entryId, subject, leaveTypeKey, entryKind, delta,
  effectiveDate, requestId }`. Note that **bookings and reversals emit this too** (from
  inside `decideAbsence`/`cancelAbsence`): a consumer that only cares about ledger
  movement can subscribe to this one event and see every delta, whatever minted it.
- `absence.requested` — `{ requestId, subject, leaveTypeKey, startDate, endDate, days }`.
- `absence.decided` — `{ requestId, subject, leaveTypeKey, decision, bookingId }`, plus
  `days`/`startDate`/`endDate` on approval. One transition, one event — there is no
  separate `absence.booked`; the booking's id is on the decision.
- `absence.cancelled` — `{ requestId, subject, leaveTypeKey, priorStatus, reversalId }`.
  `priorStatus` tells a consumer whether balance moved (`approved` → a reversal exists)
  or not (`requested` → `reversalId: null`).
- `absence.expired` — `{ requestId, subject, startDate }`, emitted under the system
  actor, which is how an audit reader distinguishes the schedule from a person.

## PII and the subject key

Every subject-bearing event is `piiClass: 'pseudonymous'` with `subjectId` set to the
**vertical-supplied `DataSubjectId`** stored on the row — the erasure key travels with
every fact about a person, so crypto-shredding that subject shreds their absence trail in
one keyed sweep while the scope's aggregate numbers survive.

`absence.leave-type-configured` is `piiClass: 'none'` — policy, not people.

The engine never invents that id: the vertical passes it on every write (Meridian passes
the employee id its whole hr.\* spine already shreds on; a route planner passes its
resource id). Choosing an id that actually maps to the person is the vertical's
responsibility, stated here because nothing downstream can fix a wrong choice.

## Versioning

Every event is emitted at `schemaVersion: 1`. Payload fields are **frozen once shipped**:
additions are fine, renames/removals/retypes mean a `schemaVersion` bump with a dual-emit
deprecation window — the platform-wide rule, restated because ledger events are exactly
the kind downstream payroll and reporting consumers quietly grow to depend on.
