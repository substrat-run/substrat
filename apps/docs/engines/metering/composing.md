# Composing & extending

## Using it as-is

Register it and the default bindings work:

```ts
import { meteringModule } from '@substrat-run/engine-metering';
host.registerModule(meteringModule);
```

That gets you meter registration, recording, totals, and period close under the engine's
own permission keys. Most verticals wrap `recordUsage` instead, because recording
happens inside an operation that is already doing something — completing an AI turn,
sampling storage — and belongs in that same transaction.

## Recording from your operations

The canonical composition — the builder portal recording an AI turn's token usage:

```ts
host.defineOperation('builder/complete-turn', async (ctx, input) => {
  assertAllowed(await ctx.check(MY_PERM.turn));
  // … the turn's own work …
  recordUsage(ctx, {
    meter: 'ai.tokens.input',
    qty: String(input.usage.inputTokens),
    subject: projectRef(input.projectId),     // attribution: whose bill line is this
    dedupeKey: input.turnId,                  // idempotency: a retried turn never double-bills
  });
  recordUsage(ctx, {
    meter: 'ai.tokens.output',
    qty: String(input.usage.outputTokens),
    subject: projectRef(input.projectId),
    dedupeKey: input.turnId,                  // same key, different meter — fine by design
  });
  return …;
});
```

**High-volume sources pre-aggregate before recording.** The ledger is the billable
plane, not a telemetry sink: if you are metering requests, roll them up host-side and
record one counter entry per bucket, with the bucket id as the dedupe key —

```ts
recordUsage(ctx, {
  meter: 'api.requests',
  qty: String(hourlyCount),
  dedupeKey: `requests:2026-08-14T13`,   // re-running the rollup is safe
  occurredAt: '2026-08-14T13:00:00Z',
});
```

— and leave the raw firehose on the platform's Analytics Engine plane, where it belongs.
Gauges sample the same way: a daily storage reading is one entry
(`dedupeKey: 'storage:2026-08-14'`), and silent days carry the level forward at close.

## Tagging entries: subject, side table — never the meter key

Three tools, three jobs:

- **`subject`** is the one first-class attribution ref — the noun a bill line splits on
  (a builder project, a site). Opaque, filterable, in every `usage-recorded` payload.
- **A side table keyed by the entry id** is how a vertical attaches anything richer —
  message id *and* model *and* region. `recordUsage` returns the entry; store
  `(entry.id, …your columns)` in your own table, same transaction. This is the
  platform's standard extra-data pattern, and it needs no engine change.
- **The meter key is not a tag.** It is the billing dimension — one frozen kind/unit,
  one line per closed period. Encoding a resource id into it
  (`ai.tokens.input:msg-123`) explodes the registry, shatters the period lines, and
  turns the vertical's price list into a junk drawer. If you are tempted, you wanted
  `subject` or a side table.

The dedupe key, meanwhile, often *is* a resource id (a turn id) — that gives you a free
lookup handle, but its contract is idempotency: derive it from the observation's
identity and expect nothing more of it.

## Pricing and the invoicing hand-off

The engine emits quantities; you price them. The wiring mirrors the timesheet close:

```ts
// Your consumer on metering.period-closed — parse YOUR OWN Zod view of the payload.
const onPeriodClosed: ConsumerHandler = (ctx, event) => {
  const p = myPeriodClosedPayload.parse(event.payload);
  const billable = p.lines
    .map((l) => priceLine(ctx, l))            // meter key → rate: YOUR price list
    .filter((b) => b !== null);
  // hand the priced lines to invoicing (or emit your own priced event), dedup on p.periodId
};
```

*When* to close is yours too: declare a schedule in your manifest that calls
`closePeriod` monthly, or bind it to your own billing-run operation. The engine
deliberately ships no schedule — close cadence is billing policy.

## Growth, archival, and what stays out of the ledger

Billable-granularity entries are small — a hyperactive AI-builder scope accumulates
well under a megabyte a day — because the high-volume plane is elsewhere by design. If
a scope's ledger ever does grow heavy, the **close horizon is the archival seam**:
everything behind it is frozen and will never be re-aggregated, so platform tooling can
export pre-horizon entries to object storage as an evidence pack and prune the hot
rows, keeping the period lines as the summary of record. That is host-side tooling — an
engine cannot reach the network — and does not exist yet; it is noted here so nobody
solves the growth question by moving the ledger *out* of the scope, which would forfeit
the transactionality the dedupe and horizon invariants stand on.

## What extension is *not*

The engine registers one frozen constant — no options object, no config field. When you
need different behaviour, you compose (your operation calling in-scope functions), store
(pricing and vocabulary as scope data), or gate (the entitlement flag). If you find
yourself wanting to fork it — a third meter kind, per-subject close lines, a
time-weighted gauge — that is a boundary finding worth filing, not patching around:
aggregation semantics are exactly the invariants the engine exists to keep identical
everywhere, and each of those has a designed additive path.
