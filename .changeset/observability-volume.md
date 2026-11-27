---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
---

Workers observability volume is measured per app and installation (#3358): with `OBSERVABILITY_VOLUME_ROLLUP=on`, the daily cost rollup reads each day's log lines and spans per script from the telemetry query (`createObservabilityVolumeReader`), with the tenant and scope a stamped line names and the stored size in bytes, and records them as `log_events`, `log_bytes`, `span_events` and `span_bytes`. A line naming its tenant is attributed to that installation (`line`); the rest goes to the app's owner. Measured, not billed yet.
