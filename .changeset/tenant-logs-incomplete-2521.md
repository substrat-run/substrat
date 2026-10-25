---
"@substrat-run/control-plane-api": minor
---

`GET /observability/tenant-logs` now says what `GET /observability/logs` says: `x-substrat-logs-incomplete: 1` beside the list when a page the backend returned full lost a line to the platform's own filtering (the wire-signing line) and so may be missing lines behind the cut. The body is unchanged. `ObservabilityReader.tenantLogs` answers `{ events, incomplete }` like `recentLogs`, which a reader that implements the seam must now do; the Cloudflare reader sets `incomplete` only for this tenant's own pages (a request's per-invocation page keeps the slot the filtered line took, so a single wire line leaves it whole).
