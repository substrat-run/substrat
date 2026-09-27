---
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
---

`_substrat_schedule_state` now carries an `invocation_id` column (#1525). When a due schedule runs — whether the operation succeeds or is denied — its row records the same id stamped onto the outbox events, deliveries and denials that call produced, so all of them can eventually be read back as one request. A schedule still inside its cadence window, a switched-off pass, and the freshness evaluator's own verdicts all leave it null, as does any row written before this release. An existing scope picks up the column automatically on its next wake; nothing needs to be re-provisioned or re-pushed. Nothing reads the column yet — this is the storage half only, and it does not appear in Workers Logs or the dashboard.
