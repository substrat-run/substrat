---
'@substrat-run/engine-invoicing': minor
---

Additive third consumed event: `timesheet.period-closed`. A closed (approved)
period of reported time appends lines to the customer's open underlag —
snapshot-not-join, `source_type: 'timesheet'`, idempotent on the closing
artifact's id. Same pattern `commerce.order-placed` was added with: a new
`consumes` entry + the engine's own Zod parse + a consumer; no migration, no
permission.
