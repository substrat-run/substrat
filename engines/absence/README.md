# @substrat-run/engine-absence

Absence engine for [Substrat](https://github.com/substrat-run/substrat) — an
**append-only entry ledger over an opaque subject**, with approval as the only way onto it.

It knows nothing about who its subjects are, what "VAB" means, how vacation accrues,
which days are weekends or red days, or what a holiday calendar says — all of that is
vertical policy. It takes a subject ref the vertical provides and guards the ledger's
integrity over it; it never owns a directory.

## What it owns

- **The ledger is append-only.** An accrual, a booking, a correction, a carryover, or a
  reversal is a new entry, never an edit. Balance is a **pure fold** over entries — no
  stored counter exists to drift.
- **Only an approved request books.** The `requested → approved | rejected → cancelled`
  state machine cannot skip, and `booking`/`reversal` entries are mintable only through
  `decideAbsence`/`cancelAbsence` — a construction, not a convention.
- **A per-leave-type balance floor**, enforced at decision time. Floor `0` refuses
  overdraft; a negative floor admits advance leave (*förskottssemester*) with no code
  change.
- **The subject is an opaque `EntityRef` + a vertical-supplied `DataSubjectId`** — an
  employee, a plannable resource, whatever the vertical's noun is. The
  `DataSubjectId` keys crypto-shredding on every event.
- **Every mutation emits a fat event** — `absence.requested`, `absence.decided`,
  `absence.cancelled`, `absence.entry-recorded`, … — so consumers never query back.
- **Stale requests expire under a system actor** (`absence/expire-stale`, declared as a
  manifest schedule): a leave nobody approved before it began is cancelled by the
  platform sweep, attributed to the schedule and never to a manager.

## Install

```sh
pnpm add @substrat-run/engine-absence
```

```ts
import { absenceModule, requestAbsence, availability, PERM } from '@substrat-run/engine-absence';
import { assertAllowed } from '@substrat-run/kernel';

host.registerModule(absenceModule);

// A vertical composes the in-scope functions inside its own operations — same
// transaction, its own permission check, its own directory:
host.defineOperation('crew/request-leave', async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.request, resourceRef(input.resourceId)));
  requireResourceExists(ctx, input.resourceId); // the directory is YOURS, not the engine's
  return requestAbsence(ctx, {
    subject: { ref: resourceRef(input.resourceId), dataSubjectId: input.resourceId },
    leaveTypeKey: input.type, // your vocabulary, registered via configureLeaveType
    startDate: input.from,    // calendar days, inclusive
    endDate: input.to,
    days: input.days,         // YOU compute the day count (weekends, red days)
  });
});
```

The planner's read is `availability(ctx, { subject, from, to })` — every date covered by
an approved absence, for the vertical to compose with its own holiday calendar.

## Documentation

**https://substrat.net/engines** — the domain model and ledger invariants, the full
operation/permission surface, the event contracts, and how a vertical composes or extends it.

The docs site is the single source of truth; this README deliberately doesn't restate it.

## Related packages

- [`@substrat-run/kernel`](https://npmjs.com/package/@substrat-run/kernel) — the
  scope-host contract these operations run on
- [`@substrat-run/contracts`](https://npmjs.com/package/@substrat-run/contracts) — the
  branded IDs, `EntityRef`, `DataSubjectId`, and manifest schemas in the surface

## Status

Pre-release (0.x): surfaces change without notice until the first vertical ships.
