---
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
---

`_substrat_schedule_state` now carries an `invocation_id` column (#1525). When a due schedule runs — whether the operation succeeds or is denied — its row records the same id stamped onto the outbox events, deliveries and denials that call produced, so all of them can eventually be read back as one request. A schedule still inside its cadence window, or a switched-off pass, writes no row at all, so it keeps whatever id the schedule's last real run left there (or no row, if it has never fired). Only two cases are actually null: the freshness evaluator's own verdicts, since they never invoke anything, and any row written before this release. An existing scope picks up the column automatically on its next wake; nothing needs to be re-provisioned or re-pushed. Nothing reads the column yet — this is the storage half only, and it does not appear in Workers Logs or the dashboard.
