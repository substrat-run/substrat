---
'@substrat-run/control-plane-api': minor
'@substrat-run/dashboard': minor
---

Per-app Observability tab (#471): the app detail page gains logs + metrics for
the app's vertical, per deployed version, with level / message-search filters
and a 1h/24h/72h window. The `ObservabilityReader` contract grows an optional
`search` term (neutral substring-on-message capability — each backend maps it
to its own query language; Cloudflare's reader files it as a telemetry-query
filter), threaded through the plane's `/observability/logs` route. Isolation is
unchanged in kind and now tested wider: "filtered by app" narrows the ownership
map server-side (an unowned slug answers `[]` without the staff-wide query ever
issuing), and builder log responses are projected to the neutral field set — a
backend's `raw` payload never passes through the seam.
