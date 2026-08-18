---
description: "Registering the absence engine, the subject boundary that keeps it free of any employee directory, and why accrual, carryover and the calendar stay in your vertical."
---

# Composing & extending

## Using it as-is

Register it and the default bindings work:

```ts
import { absenceModule } from '@substrat-run/engine-absence';
host.registerModule(absenceModule);
```

That gets you leave-type registration, the request → approve flow, balances, and
availability under the engine's own permission keys. Most verticals wrap `request` and
the reads instead, because that is where their directory and their vocabulary live.

## The subject boundary

**The engine never owns a directory.** Every write takes
`subject: { ref, dataSubjectId }`, and the engine stores the pair without ever
dereferencing it. That one line is what lets the same engine serve very different
verticals:

- an HR product binds `{ entityType: 'employee', entityId }` from its own employee table,
  with the employee id as the erasure key;
- a field-service planner binds `{ entityType: 'resource', entityId }` from its resource
  register — where a *resource* is a plannable unit, not an identity: one human can be
  two resources, and a resource with no login still gets sick.

Two consequences you own:

1. **Existence checks are yours.** The engine accepts any ref; verify the employee/resource
   exists in *your* operation, before the engine call.
2. **The `dataSubjectId` must actually map to the person.** It keys crypto-shredding on
   every event the write emits; choose the id your erasure path already shreds on.

## The vocabulary split

The engine's `absence_leave_types` row is deliberately skeletal: **key, floor, active**.
Everything a human sees lives in *your* table, keyed by the same string:

```ts
// Your operation, one transaction: your vocabulary row + the engine's policy row.
host.defineOperation('hr/define-leave-type', async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.configure));
  upsertMyLeaveTypeVocabulary(ctx, input);          // label, kind, statutory days — yours
  configureLeaveType(ctx, { key: input.key });       // key + floor — the engine's
  return …;
});
```

Per-country divergence is data, not forks: a Swedish scope registers `vacation` with 25
statutory days in its vocabulary and *VAB* as a type; a Spanish scope registers 22 and
*baja* — same engine, same keys where they overlap, different vocabulary rows per scope.

**The floor is the one policy knob the engine holds.** `floor: '0'` (the default) refuses
overdraft; `floor: '-25'` is *förskottssemester* — advance vacation up to 25 days —
enforced at decision time with no vertical code.

## Accrual, carryover, and the calendar — yours

The engine records entries; it never generates them. The compositions:

- **Accrual rules** — your schedule or your operation calls
  `recordEntry(…, entryKind: 'accrual')` per your formula (annual grant, monthly
  fraction, tenure tiers).
- **Year-end carryover** — a vertical-declared schedule that folds each subject's balance
  and writes `carryover` entries per your caps. The trigger seam (a manifest schedule) is
  the same one the engine itself uses for expiry.
- **Day counting** — the `days` on a request is yours to compute (weekends, red days,
  half-days), which is also why the engine never checks it against the date range.
- **The availability verdict is half of the planner's answer.**
  `availability(ctx, { subject, from, to })` returns dates covered by approved absence;
  compose it with your holiday calendar for "is Hugo actually out Monday":

```ts
const { days } = availability(ctx, { subject: resourceRef(id), from, to });
const out = new Set(days.map((d) => d.date));
const holidays = myRedDays(ctx, from, to);          // your scope's calendar
return dates.filter((d) => !out.has(d) && !holidays.has(d));
```

## Composing the window reads

`entriesInWindow(ctx, { from, to, entryKind: 'booking' })` is in-scope only — no
operation binding — because its two known callers are vertical compositions with their
own gates: a **payroll export** collecting the period's booked absence next to approved
expenses, and a **planner** sweeping a route window across every resource. Wrap it behind
your own permission; the engine deliberately does not decide who may see everyone at once.

## What extension is *not*

The engine registers one frozen constant — no options object, no config field. When you
need different behaviour, you compose (your operation calling in-scope functions), store
(vocabulary as scope data), or gate (the entitlement flag). If you find yourself wanting
to fork it — a sixth entry kind, an approval step the machine doesn't have — that is a
boundary finding worth filing, not patching around: the state machine and the entry-kind
mint are exactly the invariants the engine exists to keep identical everywhere.

## The extraction handoff, if you were vertical-first

If you already run an absence ledger as vertical tables, adopt the engine the way the
seeding HR vertical did:

1. register `absenceModule` **before** your module (registration order = migration
   order, so the engine's tables exist when your journal runs);
2. a one-time extraction-handoff migration (`boundary-lint-allow R5` — the one sanctioned
   write to another module's schema) copies your ledger and requests into `absence_*`,
   mapping your subject id into the (`subject_type`, `subject_id`, `data_subject_id`)
   triple, and registers your leave-type keys;
3. your operations become compositions of the in-scope functions — behind your unchanged
   HTTP surface, if you keep a thin mapping layer.
