# Operations, functions & permissions

## Operations

Registered bindings, each one a permission check plus a call into the in-scope function
below.

| Operation | Permission | Does |
|---|---|---|
| `absence/configure-leave-type` | `absence:configure` | register/update a leave type's key, floor, active flag |
| `absence/list-leave-types` | `absence:read` | list registered types |
| `absence/record-entry` | `absence:configure` | append an `accrual` / `correction` / `carryover` entry |
| `absence/request` | `absence:request` *(per subject)* | file a request for a subject |
| `absence/decide` | `absence:approve` | approve (books, floor-checked) or reject |
| `absence/cancel` | `absence:approve`, **or** `absence:request` *(per subject)* for one's own still-`requested` row | withdraw or cancel; an approved cancel writes the reversal |
| `absence/expire-stale` | `absence:approve` | cancel requests past their start date — the declared schedule's target |
| `absence/balance` | `absence:read` *(per subject)* | balance-as-of fold |
| `absence/availability` | `absence:read` *(per subject)* | per-date coverage over a range |
| `absence/list-requests` | `absence:read` *(per subject when filtered, node otherwise)* | requests, by subject and/or status |
| `absence/list-entries` | `absence:read` *(per subject)* | the raw ledger for a subject |

Checks marked *(per subject)* pass the subject's `EntityRef`, so a principal holding an
**entity-narrowed grant** on their own ref — an employee, a fältarbetare with a login —
reaches their own balance, requests, and withdrawals while holding no role at all. Node
holders (managers, planners, HR) pass the same checks unnarrowed.

## In-scope functions

The composable surface. A vertical calls these **inside its own operation and its own
permission check**, in one transaction — this is how you extend the engine without
forking it.

```ts
configureLeaveType(ctx, { key, floor?, active? })                → LeaveType
listLeaveTypes(ctx)                                              → LeaveType[]
recordEntry(ctx, { subject, leaveTypeKey, entryKind,             // accrual|correction|carryover
                   delta, effectiveDate, note? })                → AbsenceEntry
requestAbsence(ctx, { subject, leaveTypeKey,
                      startDate, endDate, days, note? })         → AbsenceRequest
decideAbsence(ctx, { requestId, decision, note? })               → { request, booking: AbsenceEntry | null }
cancelAbsence(ctx, { requestId, reason? })                       → { request, reversal: AbsenceEntry | null }
expireStaleRequests(ctx)                                         → { expired: number }
balanceAsOf(ctx, { subject, leaveTypeKey, asOf? })               → string          // pure fold
availability(ctx, { subject, from, to })                         → { days, requests }
listRequests(ctx, { subject?, status? })                         → AbsenceRequest[]
listEntries(ctx, { subject, leaveTypeKey? })                     → AbsenceEntry[]
entriesInWindow(ctx, { from, to, entryKind? })                   → AbsenceEntry[]  // in-scope only, no binding
```

Every **write** takes a `subject`:

```ts
subject: {
  ref: EntityRef,               // your noun — { entityType: 'employee' | 'resource' | …, entityId }
  dataSubjectId: DataSubjectId, // keys erasure on every event this write emits
}
```

**Reads** take the bare `ref` — no erasure key is needed to look.

Notes worth knowing:

- `decideAbsence(approve)` **re-folds at decision time** and enforces the leave type's
  floor then — the request may be days old and the world may have moved.
- `cancelAbsence` on an `approved` request writes the compensating `reversal` in the same
  transaction as the status change; on a `requested` row it touches no ledger.
- `entriesInWindow` has **no operation binding** — it exists for vertical compositions
  (a payroll export collecting the period's bookings; a planner sweeping a route window)
  that gate it behind their own permission.
- `availability` clamps to the queried range and reports **approved** coverage only — a
  merely-requested absence never shows as covered.

## Permissions

`absence:read` · `absence:request` · `absence:approve` · `absence:configure`

- **`absence:request`** is the self-service key: granted entity-narrowed on a subject's
  own ref, it lets that person file — and withdraw — their own requests, and nothing else.
- **`absence:approve`** covers deciding, cancelling an approved absence, and the expiry
  sweep — it is also the single permission the declared schedule's system principal is
  granted, which is exactly what appears in the permission diff.
- **`absence:configure`** covers leave-type policy and direct ledger writes
  (`recordEntry`) — the administrator's escape hatch, deliberately floor-unchecked.
- **`absence:read`** unnarrowed is the planner's and manager's view; narrowed, it is
  "my balance".
