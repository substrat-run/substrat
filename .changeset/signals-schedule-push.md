---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'create-substrat': patch
---

A hosted vertical's schedule outcomes reach the platform's sweep record (#1232,
closing the CP-less gap the last release named). The scope sweeper batches each
pass's per-schedule outcomes — skips included, stamped with PASS time and the
version whose code actually ran (`env.SUBSTRAT_VERSION_ID`) — into one
`sweep-runs` platform intent per scope, which the control plane's drain lands in
`_substrat_sweep_runs` with identity proven by the scope the intent lives in,
never read from the payload. Telemetry gets its own low sub-cap on the journal
and DROPS rather than throws when full: a pass must never fail, or starve a
provision-sibling's slot, because its record could not be queued.

The write is now idempotent on (intent id, unit) — a new nullable `request_id`
column with a unique index and an ignore-on-conflict insert — so a replayed
drain writes nothing twice, while the direct sweep path (no request id) dedupes
nothing, as two real passes are two facts. `SweepRunInput` gains optional `at`
(a drained batch keeps pass time; drain time would skew every freshness read)
and `requestId`. The template's sweeper wires the version accessor; existing
workers compile untouched — the accessor and the host method are optional, and
a pass on a pre-widening deployment reports nothing, exactly as before.
