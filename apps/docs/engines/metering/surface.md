# Operations, functions & permissions

## Operations

Registered bindings, each one a permission check plus a call into the in-scope function
below.

| Operation | Permission | Does |
|---|---|---|
| `metering/configure-meter` | `metering:configure` | register a meter (kind/unit frozen thereafter); update description/active |
| `metering/list-meters` | `metering:read` | list registered meters — a **page**, walked by `key` |
| `metering/record` | `metering:record` | append a usage entry — idempotent on `(meter, dedupeKey)` |
| `metering/total` | `metering:read` | window aggregate for one meter — the same code path a close freezes |
| `metering/list-entries` | `metering:read` | raw entries, filterable by meter / subject / window — a **page**, walked by `(occurredAt, id)` |
| `metering/close-period` | `metering:close` | freeze `[from, to)` into lines, advance the horizon, emit the fat event |
| `metering/list-periods` | `metering:read` | the close journal — a **page**, walked by `(from, id)` |
| `metering/period-lines` | `metering:read` | a closed period's frozen lines — a **page**, walked by `meterKey` |

The four reads answer `Page<T>`, not a bare array (#959). The **in-scope** functions beside
them stay unpaged: a vertical composing one inside its own transaction is folding it —
pricing a period's lines, summing a window — not rendering a table. A caller that needs the
whole ledger walks the cursor.

## In-scope functions

The composable surface. A vertical calls these **inside its own operation and its own
permission check**, in one transaction — this is how you extend the engine without
forking it.

```ts
configureMeter(ctx, { key, kind, unit, description?, active? })  → Meter
listMeters(ctx)                                                  → Meter[]
recordUsage(ctx, { meter, qty, subject?, occurredAt?,
                   dedupeKey, note? })                           → { entry, deduped: boolean }
usageTotal(ctx, { meter, from, to })                             → { qty, entryCount } | null
listEntries(ctx, { meter?, subject?, from?, to? })               → UsageEntry[]
closePeriod(ctx, { from, to })                                   → { period, lines: PeriodLine[] }
listPeriods(ctx)                                                 → MeteringPeriod[]
periodLines(ctx, { periodId })                                   → PeriodLine[]
```

Notes worth knowing:

- **`recordUsage` returns `{ entry, deduped }`** — `deduped: true` means the key had
  already been recorded (same qty), the existing entry came back, and **no event was
  emitted**. A retry loop can call it blindly.
- **The dedupe key is a contract, not a suggestion.** Derive it from the observation's
  own identity — a turn id, an aggregation-bucket id (`requests:2026-08-14T13`) — never
  from a random value, or the idempotency is theatre.
- **`occurredAt` defaults to now** and must be at or after the close horizon. Record
  late usage at observation time; never backdate into a closed window (the engine
  refuses).
- **Gauges reject negative samples**; counters take signed deltas — a correction is a
  compensating negative entry.
- **`usageTotal` returning `null`** means the meter has nothing to say for the window: a
  counter with no entries, or a gauge never sampled at all. A gauge with no *in-window*
  samples returns its carried-forward level with `entryCount: 0`.
- **`subject` is optional and opaque** — an `EntityRef` the engine stores and never
  dereferences, for attribution and filtering ([composing](./composing) covers when to
  use it versus a side table).

## Permissions

`metering:read` · `metering:record` · `metering:configure` · `metering:close`

- **`metering:record`** is the ingest key — what a vertical's turn-completion or
  sampling operation holds. It does not grant closing.
- **`metering:close`** freezes billing evidence and advances the horizon — hold it to
  the same standard as invoicing's export permission, because a close is what turns
  entries into a bill.
- **`metering:configure`** registers meter vocabulary. Kind/unit freezing means this key
  cannot rewrite history, only extend it.
- **`metering:read`** covers meters, entries, totals and closed periods alike — usage
  data is one audience (the tenant's admins), not many.
