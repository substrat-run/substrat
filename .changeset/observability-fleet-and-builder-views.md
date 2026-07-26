---
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': minor
'@substrat-run/console': minor
'@substrat-run/dashboard': minor
'@substrat-run/router': minor
'@substrat-run/ui': patch
---

Observability, views 1–3 of design/observability.md — piggyback Cloudflare, stamp
what only we know:

- **Seam + Cloudflare reader** (`control-plane-api`): a provider-neutral
  `ObservabilityReader` contract (service/namespace vocabulary, never
  script/dispatch-namespace) with `createCfObservabilityReader` as the injected
  Cloudflare implementation (GraphQL invocation analytics + the Workers
  Observability telemetry query API) — the `DeployVerticalFn`/`wfp.ts` pattern, so
  an APM/OTel backend can slot in behind identical routes later. Two staff-only
  proxy routes: `GET /observability/metrics` and `GET /observability/logs`
  (501 when no backend is configured; deliberately not in `BUILDER_ROUTES`).
- **Router**: one Analytics Engine datapoint per resolved request — index
  `tenantId`, blobs `(vertical, scope, surface, statusClass, rayId)`, doubles
  `(durationMs, status)` — plus a structured JSON log line with the same fields.
  The router is the only place that knows which tenant a request belonged to;
  written now so tenant-keyed history accrues before any tenant-facing read path
  exists. Metering never fails a request, and error paths are counted.
- **WfP uploads**: pushed verticals get `observability: { enabled: true }`, so
  builder logs exist to query.
- **Console**: an Observability fleet view — per-service invocations, error
  rates, CPU quantiles, and a row-click recent-logs panel.
- **Dashboard**: a Traffic panel on the Verticals view showing the team's own
  deployed versions (requests/errors/CPU + recent logs). Owner-narrowing lives in
  `TenantNarrowedControlPlane`: metrics rows are filtered to owned deployment
  refs and mapped back to (vertical, version); a logs query for an unowned ref
  answers `[]` without ever reaching the plane.

Deploy notes: the control plane's `CF_API_TOKEN` additionally needs **Account
Analytics: Read** and **Workers Observability: Read**; the router redeploy picks
up the `substrat_router` AE dataset binding (auto-created on first write).
