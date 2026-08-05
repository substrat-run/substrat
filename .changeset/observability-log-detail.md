---
"@substrat-run/control-plane-api": minor
"@substrat-run/dashboard": minor
---

feat(observability): richer per-app log detail — carry trigger/eventType/entrypoint/requestId/timing through the neutral seam, plus an expandable raw event

The observability read seam (`RecentLogEvent`) now carries `trigger`, `eventType`,
`entrypoint`, `requestId`, and CPU/wall timing alongside `message`/`level`, mapped from the
Cloudflare backend in neutral vocabulary (no provider field names leak past the seam). The
dashboard's per-app and per-vertical log panels render these inline — the trigger leads
(e.g. `default.importDump`), with the message, `eventType · entrypoint`, outcome, CPU time,
and request id — and a row expands to the full JSON event, the drill-down Cloudflare's own
console gives.

The tenant-narrowing wrapper now passes the backend `raw` event through for an **owned**
service: the ownership gate already proved the service is this tenant's, so the event is its
own telemetry, and that gate — not a trimmed field set — remains the boundary.
