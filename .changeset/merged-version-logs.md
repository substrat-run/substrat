---
"@substrat-run/control-plane-api": minor
---

feat(observability): one merged log stream across a vertical's versions

The log read seam narrows to a **set** of services (`services: string[]`) instead of one:
a builder's unit of interest is a vertical, which serves from several deployed units at
once (the stable serving script plus per-version archives). `GET /observability/logs`
accepts a repeated `service` param (capped at 20 — one backend query each) and answers the
services' events merged newest-first, capped at `limit` overall. A single `service` param
behaves exactly as before, and no `service` at all is still the fleet view.

Consumer-side: the dashboard's per-app Observability tab now shows logs under "All
versions" — every version that served, merged, with a version chip per line — where it
previously showed nothing until one version was picked. Unowned refs are still dropped by
the tenant narrowing before the plane is asked, so a mixed set is a request, never a claim.
