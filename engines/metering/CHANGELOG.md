# @substrat-run/engine-metering

## 0.1.7

### Patch Changes

- Updated dependencies [f869541]
- Updated dependencies [f869541]
- Updated dependencies [19fb697]
- Updated dependencies [f869541]
- Updated dependencies [717600e]
- Updated dependencies [46b1cac]
- Updated dependencies [9208b4e]
  - @substrat-run/kernel@0.72.0
  - @substrat-run/contracts@0.72.0

## 0.1.6

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0
  - @substrat-run/kernel@0.71.0

## 0.1.5

### Patch Changes

- Updated dependencies [9bb7975]
  - @substrat-run/contracts@0.70.0
  - @substrat-run/kernel@0.70.0

## 0.1.4

### Patch Changes

- Updated dependencies [17a82ec]
  - @substrat-run/contracts@0.69.0
  - @substrat-run/kernel@0.69.0

## 0.1.3

### Patch Changes

- Updated dependencies [60789c8]
- Updated dependencies [aaf41b8]
- Updated dependencies [a05cd4d]
- Updated dependencies [b9dbda9]
- Updated dependencies [4eb532b]
  - @substrat-run/contracts@0.68.0
  - @substrat-run/kernel@0.68.0

## 0.1.2

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
- Updated dependencies [ee95fd6]
  - @substrat-run/contracts@0.67.0
  - @substrat-run/kernel@0.67.0

## 0.1.1

### Patch Changes

- Updated dependencies [954668b]
  - @substrat-run/kernel@0.66.0
  - @substrat-run/contracts@0.66.0

## 0.1.0

### Minor Changes

- f4529ed: `engine-metering` v0 (#646): the billable-usage ledger. D-31 deferred metering
  "until a vertical meters something" — the builder token economy is that trigger.
  The engine owns an append-only usage ledger over configured meters (kind/unit
  frozen after creation), idempotent ingest keyed by `(meter, dedupeKey)` (a
  replayed turn can never double-bill; a reused key with a different qty throws),
  the counter/gauge aggregation split (counters sum signed deltas; gauges take
  max-in-window and carry their level across silent windows), and an append-only
  period-close journal whose latest `to` is a hard horizon no new entry may land
  behind — closed periods stay reproducible from their entries forever.

  `closePeriod` emits one fat `metering.period-closed` event with **unpriced**
  lines (`{meterKey, kind, unit, qty, entryCount}`): pricing is vertical
  vocabulary, and the vertical feeds invoicing exactly like the
  `timesheet.period-closed` hand-off. This is the _billable_ metering plane;
  platform metering stays Analytics Engine (D-46 pattern) — two planes, kept
  separate on purpose (`docs/design/engine-metering.md`).
