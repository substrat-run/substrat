---
'@substrat-run/dashboard': patch
---

The dashboard's global error handler flattened every non-`HTTPException` throw to a
`400`, so an internal control-plane failure surfaced to the browser as a misleading
`400: internal error` — a server/upstream fault dressed up as the caller's mistake. The
concrete casualty was the app Observability tab: when the CF token behind the plane's
observability reader lacks `Workers Observability: Read`, the telemetry query 403s, the
plane maps it to a genuine `500 internal error`, and the dashboard client wraps that as a
`ControlPlaneError(500)` — which then collapsed to `400` at `onError`. The `/observability/logs`
route answered `400` while metrics (a different, working CF API) rendered fine.

Honor `ControlPlaneError.status` in `onError` instead: a `500` stays a `500`, a `501`
(observability not configured) stays a `501`, and an unreachable plane (`status 0`)
becomes a `502`. Plain-`Error` refusals still default to `400` with the existing
`permission denied` → `403` / `not one of your deployments` → `404` re-maps intact.
