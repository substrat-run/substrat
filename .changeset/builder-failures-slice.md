---
"@substrat-run/control-plane-api": minor
"@substrat-run/dashboard": minor
"@substrat-run/dashboard-web": minor
---

feat(dashboard,control-plane-api): builders see their own vertical's failure history (#559)

`GET /ops-failures` opens to builders, tenant-narrowed by the forced-filter
pattern (`GET /scopes` precedent): a builder reads only its own tenant's rows,
platform-level rows (null tenant) stay staff-only, and staff keep the fleet
view. The dashboard grows the pipe — a tenant-pinned `listOpsFailures` on the
authority seam, `GET /api/deployments/:slug/failures` (owned-slug-checked, with
an embedded-host fallback) — and a "Recent failures" panel on the vertical
detail: when, operation · stage, status, message, and the upstream
`reference = <id>` with a copy affordance. A red CI run is now explainable from
the dashboard without staff involvement; a `reference` row says "platform
fault, here is the Cloudflare support handle", not "your code broke".
