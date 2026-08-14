# @substrat-run/engine-metering

Metering engine for [Substrat](https://github.com/substrat-run/substrat) — billable
usage as an **append-only, idempotent meter ledger whose closed periods are frozen
billing evidence**.

It counts what happened — tokens, requests, bytes stored — and knows nothing about what
any of it costs: no prices, no currency, no plans. The vertical maps meter keys to rates
and feeds invoicing from the fat `metering.period-closed` event. It is the *billable*
metering plane, deliberately separate from the platform's high-volume telemetry plane
(Analytics Engine): durable, transactional, in the scope's own SQL — because an invoice
needs evidence a customer can dispute.

## What it owns

- **The ledger is append-only.** A usage entry is never edited or deleted; an
  over-recorded counter is corrected by a compensating negative entry.
- **Ingest is idempotent by construction.** Every `recordUsage` names a caller-supplied
  dedupe key, unique per meter (`UNIQUE (meter_key, dedupe_key)`). A replay with the
  same quantity returns the existing entry — no second row, no second event, no double
  bill; the same key with a *different* quantity throws.
- **Counters and gauges aggregate differently.** A counter (tokens, requests) is a flow
  you sum — signed deltas, corrections compensate. A gauge (bytes stored) is a level you
  sample — max-in-window, and a silent window carries the last level forward. Kind and
  unit live on the meter definition and are **frozen after creation**.
- **A closed period is evidence.** `closePeriod` freezes a half-open `[from, to)` UTC
  window into immutable per-meter lines and emits one fat event. Closes are monotonic,
  and the latest closed `to` is a hard horizon no new entry may land behind — closed
  lines stay reproducible from their entries forever.
- **Entries may carry an opaque attribution ref** (`subject: EntityRef` — a project, a
  site) for bill-splitting and filtering. The engine never dereferences it, and takes no
  `DataSubjectId`: meters count machines and bytes, not people (`piiClass: 'none'`
  throughout).

## Install

```sh
pnpm add @substrat-run/engine-metering
```

```ts
import { meteringModule, configureMeter, recordUsage, PERM } from '@substrat-run/engine-metering';

host.registerModule(meteringModule);

// A vertical composes the in-scope functions inside its own operations — same
// transaction, its own permission check:
host.defineOperation('builder/complete-turn', async (ctx, input) => {
  assertAllowed(await ctx.check(MY_PERM.turn));
  // … the turn's own work …
  recordUsage(ctx, {
    meter: 'ai.tokens.input',                 // registered once via configureMeter
    qty: String(input.usage.inputTokens),
    subject: projectRef(input.projectId),     // attribution: whose bill line is this
    dedupeKey: input.turnId,                  // idempotency: a retried turn never double-bills
  });
  return …;
});
```

High-volume sources pre-aggregate before recording (one counter entry per hour/day,
bucket id as the dedupe key); the raw firehose stays on the platform telemetry plane.

## Documentation

**https://substrat.net/engines** — the domain model and ledger invariants, the full
operation/permission surface, the event contracts, and how a vertical composes pricing
on top.

The docs site is the single source of truth; this README deliberately doesn't restate it.

## Related packages

- [`@substrat-run/kernel`](https://npmjs.com/package/@substrat-run/kernel) — the
  scope-host contract these operations run on
- [`@substrat-run/contracts`](https://npmjs.com/package/@substrat-run/contracts) — the
  branded IDs, `EntityRef`, decimal helpers, and manifest schemas in the surface

## Status

Pre-release (0.x): surfaces change without notice until the first vertical ships.
