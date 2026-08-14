# @substrat-run/engine-metering

The billable-usage engine: an append-only, idempotent meter ledger whose closed
periods are frozen billing evidence. Design: `docs/design/engine-metering.md`
([#646](https://github.com/substrat-run/substrat/issues/646)).

- **Counters** (tokens, requests) are flows you sum; **gauges** (bytes stored) are
  levels you sample — a gauge's last sample carries forward across windows.
- Every `recordUsage` names a caller-supplied dedupe key, unique per meter: a
  retried turn or replayed consumer can never double-bill.
- `closePeriod` aggregates a half-open `[from, to)` window into immutable lines and
  emits a fat `metering.period-closed` event. Closes are monotonic; the latest
  closed `to` is a hard horizon no new entry may land behind.
- The engine owns **quantities, never prices** — the vertical maps meter keys to
  rates and feeds invoicing, exactly like the `timesheet.period-closed` hand-off.

Licensed AGPL-3.0-only; commercial licenses available from Substrat.
