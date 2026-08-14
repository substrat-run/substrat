# Domain model & invariants

## Tables

```sql
absence_leave_types (
  key             TEXT PRIMARY KEY,     -- vertical vocabulary: 'vacation' | 'sick' | 'vab'
  floor           TEXT NOT NULL DEFAULT '0',   -- decimal; balance may not fold below this
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
)

absence_ledger (                        -- APPEND-ONLY. No UPDATE. No DELETE. Ever.
  id              TEXT PRIMARY KEY,     -- ulid()
  subject_type    TEXT NOT NULL,        -- the opaque ref, stored as its pair
  subject_id      TEXT NOT NULL,
  data_subject_id TEXT NOT NULL,        -- keys crypto-shredding on every event
  leave_type_key  TEXT NOT NULL,
  entry_kind      TEXT NOT NULL,        -- accrual | booking | correction | carryover | reversal
  delta           TEXT NOT NULL,        -- SIGNED decimal days
  effective_date  TEXT NOT NULL,        -- the date the entry counts from
  request_id      TEXT,                 -- set on 'booking' and 'reversal'
  note            TEXT,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL
)

absence_requests (
  id              TEXT PRIMARY KEY,     -- ulid()
  subject_type    TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  data_subject_id TEXT NOT NULL,
  leave_type_key  TEXT NOT NULL,
  start_date      TEXT NOT NULL,        -- calendar date, INCLUSIVE
  end_date        TEXT NOT NULL,        -- calendar date, INCLUSIVE
  days            TEXT NOT NULL,        -- positive decimal, vertical-computed
  status          TEXT NOT NULL,        -- requested | approved | rejected | cancelled
  note            TEXT,
  decided_by      TEXT,
  decided_at      TEXT,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL
)
```

Three deliberate shapes:

- **The subject is a stored pair** (`subject_type`, `subject_id`) — an `EntityRef` the
  engine can never dereference. Two subjects with the same id but different types (an
  `employee` and a `resource`) hold fully independent ledgers.
- **`data_subject_id` is denormalized onto every row** so a later transition (decide,
  cancel, expire) can emit a correctly-keyed pseudonymous event without the caller
  re-supplying it. The vertical decides what that id shreds to.
- **Money-style decimals** (`delta`, `days`, `floor`) are strings folded with
  `addDecimal`/`compareDecimal` — never floats.

## The five entry kinds

| Kind | Signed delta | Minted by | Meaning |
|---|---|---|---|
| `accrual` | usually `+` | `recordEntry` | entitlement granted (annual grant, monthly accrual) |
| `carryover` | `+`/`−` | `recordEntry` | balance carried across a period boundary |
| `correction` | `+`/`−` | `recordEntry` | the administrator's compensating fix — never an edit |
| `booking` | `−` | **`decideAbsence` only** | an approved request consuming balance |
| `reversal` | `+` | **`cancelAbsence` only** | the compensating undo of a booking |

`recordEntry`'s input schema refuses `booking` and `reversal` outright — the request flow
is the only mint for them, which is what turns "only an approved request touches the
ledger" from a convention into a construction.

## The invariants

- **Append-only** — nothing in the engine issues `UPDATE` or `DELETE` against
  `absence_ledger`. Corrections compensate; history survives.
- **Balance is a fold**: `balanceAsOf` = Σ `delta` over entries with
  `effective_date <= asOf`. Pure, deterministic, no stored aggregate.
- **No fold below the floor** — approval re-folds the balance *at decision time* (the
  world may have changed since the request) and rejects a booking that would breach the
  leave type's floor.
- **The state machine cannot skip** — only a `requested` row can be decided; only
  `requested` or `approved` can be cancelled; `rejected` and `cancelled` are terminal.
- **A cancelled approval reverses, never edits** — cancelling an `approved` request
  writes a `reversal` entry mirroring the booking's delta, in the same transaction as the
  status change.
- **Every mutation emits a fat event; every operation checks a permission.**

## The state machine

```
requested ──approve──▶ approved ──cancel──▶ cancelled   (+ reversal entry)
    │
    ├──reject──▶ rejected
    └──cancel / expire──▶ cancelled                      (no ledger touch)
```

**Expiry** is the platform's date-triggered seam: the manifest declares an
`absence/expire-stale` schedule (daily), so a request still `requested` past its
`start_date` is cancelled by the platform sweep under
`{ system: '@substrat-run/engine-absence' }`. The pass is idempotent (only `requested`
rows past their start) and paged (a bounded batch per pass), so a backlog drains across
passes rather than blowing one invoke.

## Days, not instants

Requests span **inclusive calendar dates** and carry a **vertical-computed** `days`
decimal. The engine never counts days from the date range — a Swedish vertical excludes
red days, a Spanish one counts differently, and half-days are decimals — so the range
answers *when* and the decimal answers *how much*. `availability()` expands approved
ranges to per-date coverage; hours-granular absence is deliberately out of v0.
