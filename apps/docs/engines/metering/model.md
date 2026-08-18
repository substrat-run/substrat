---
description: "The append-only meter ledger, the counter and gauge kinds frozen at meter creation, the dedupe key that makes ingest idempotent, and why entries are stamped as instants."
---

# Domain model & invariants

## Tables

```sql
metering_meters (
  key         TEXT PRIMARY KEY,   -- vertical vocabulary: 'ai.tokens.input' | 'storage.bytes' | …
  kind        TEXT NOT NULL,      -- counter | gauge — FROZEN after creation
  unit        TEXT NOT NULL,      -- 'tokens' | 'bytes' | 'requests' — FROZEN after creation
  description TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
)

metering_entries (                -- APPEND-ONLY. No UPDATE. No DELETE. Ever.
  id           TEXT PRIMARY KEY,  -- ulid()
  meter_key    TEXT NOT NULL,
  qty          TEXT NOT NULL,     -- decimal string; SIGNED for counters, >= 0 for gauges
  subject_type TEXT,              -- optional opaque attribution ref, stored as its pair
  subject_id   TEXT,
  occurred_at  TEXT NOT NULL,     -- UTC instant, normalized to ms precision
  dedupe_key   TEXT NOT NULL,     -- caller-supplied idempotency key
  note         TEXT,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (meter_key, dedupe_key)  -- THE invariant: one observation, one row
)

metering_periods (                -- append-only close journal; monotonic, non-overlapping
  id        TEXT PRIMARY KEY,     -- ulid()
  from_at   TEXT NOT NULL,        -- half-open [from, to)
  to_at     TEXT NOT NULL,        -- MAX(to_at) = the close horizon
  closed_by TEXT NOT NULL,
  closed_at TEXT NOT NULL
)

metering_period_lines (           -- the frozen aggregates; unpriced by design
  id          TEXT PRIMARY KEY,
  period_id   TEXT NOT NULL,
  meter_key   TEXT NOT NULL,
  kind        TEXT NOT NULL,      -- snapshot of the meter at close
  unit        TEXT NOT NULL,
  qty         TEXT NOT NULL,
  entry_count INTEGER NOT NULL    -- 0 = a gauge's carried-forward level
)
```

Three deliberate shapes:

- **The dedupe key is unique *per meter*, not globally** — one builder turn records
  `ai.tokens.input` and `ai.tokens.output` under the same turn id.
- **Instants are UTC ISO-8601 normalized to millisecond precision** on the way in, so
  lexicographic order *is* chronological order — mixed precision
  (`…T00:00:00Z` vs `…T00:00:00.000Z`) would silently break every window comparison.
- **Quantities are money-style decimal strings** folded with
  `addDecimal`/`compareDecimal` — never floats.

## The two meter kinds

| Kind | Quantity | Window aggregate | Empty window |
|---|---|---|---|
| `counter` | signed delta (a correction is a negative entry) | **Σ qty** over `[from, to)` | omitted — a zero sum bills nothing |
| `gauge` | non-negative level sample | **max sample** in `[from, to)` | **carries forward** the latest earlier sample, `entryCount: 0`; omitted only if never sampled |

The kind and unit live on the **meter definition** and are frozen after creation —
changing a unit mid-period would corrupt every aggregate that spans the change. A new
unit is a new meter key.

## The invariants

- **Append-only** — nothing in the engine issues `UPDATE` or `DELETE` against
  `metering_entries`. Corrections compensate; history survives.
- **One observation, one row, one event** — `recordUsage` with a seen
  `(meter, dedupeKey)` and the same qty returns the existing entry and emits nothing;
  with a different qty it **throws**.
- **One aggregation code path** — `usageTotal` (the preview read) and `closePeriod`
  (the freeze) share the same internal aggregation, so a preview can never disagree with
  the eventual line.
- **Closes are monotonic and non-overlapping** — a new period's `from` must be at or
  after the latest closed `to`. Gaps are allowed (metering may start mid-life); rewinds
  are not.
- **Nothing lands behind the horizon** — `recordUsage` refuses an `occurred_at` before
  the latest closed `to`, so closed lines stay reproducible from their entries forever.
  Late-arriving usage is recorded at observation time (`occurred_at` defaults to now).
- **Every mutation emits a fat event; every operation checks a permission.**

## Instants, not days

Windows are **half-open `[from, to)` UTC instants** — the
[booking engine's](/engines/booking/) convention, deliberately unlike the
[absence engine's](/engines/absence/) inclusive calendar days. Usage is machine-shaped:
a month's window is `[2026-08-01T00:00:00Z, 2026-09-01T00:00:00Z)` and an entry at
exactly the boundary belongs to exactly one period — the next one. The instant **at**
the horizon is the first legal `occurred_at` after a close.
