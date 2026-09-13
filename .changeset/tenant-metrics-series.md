---
'@substrat-run/control-plane-api': minor
---

`tenantMetricsSeries` joins `tenantMetrics` on the observability seam (#1447): the same tenant-grain traffic, bucketed over time, one series per installed app, each bucket carrying requests, errors and the weighted P50/P95 latency, accepting a list of scopes (up to `TENANT_SERIES_SCOPE_CAP`) so "all my apps" is one read. The Cloudflare reader answers it from the router's Analytics Engine dataset — the only place the tenant dimension exists — and a new `GET /observability/tenant-metrics-series` route serves it, 501 when the reader cannot bucket. Additive: an optional seam method and a new route, nothing existing changes shape.
