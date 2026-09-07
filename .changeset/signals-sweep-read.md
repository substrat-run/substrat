---
'@substrat-run/control-plane-api': minor
---

The sweep record gets its read path (#1232 PR 2). `GET /sweep-runs` serves the
`_substrat_sweep_runs` rows with every filter the store supports — kind, unit,
outcome, tenant, scope, vertical, connection, a time window, and the ULID
cursor — tenant-narrowed by the forced-filter pattern (a builder's tenant comes
from the principal; staff read fleet-wide, the console's later view) and
builder-allowlisted. On top of it, the dashboard's Integrations surfaces answer
the question nothing could before: every connection now shows a recent-runs
strip — one tick per sweep pass, green/amber/red — and "Last sweep …", in the
connection detail (folded into the existing activity fan-out, no extra round
trip) and on every account-list row (one bulk windowed read for the whole
tenant, never a call per connection). A sweep that found nothing to do, and a
connection that is bound but has no sweeper polling it, are now visible facts
rather than absences.
