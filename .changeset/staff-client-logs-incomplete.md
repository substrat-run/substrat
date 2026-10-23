---
"@substrat-run/control-plane-api": minor
---

The staff client can read what `GET /observability/logs` says beside its list. `ControlPlaneStaffClient.recentLogsRead` answers `{ events, incomplete }`: `incomplete` is `true` exactly when the plane set `x-substrat-logs-incomplete: 1`, meaning the page may be incomplete or missing newer lines. `recentLogs` is unchanged and still answers the bare list. The browser entry now also exports `LOGS_INCOMPLETE_HEADER`, and the type `RecentLogsRead`.
