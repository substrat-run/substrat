---
'@substrat-run/control-plane-api': minor
---

Logs Lines can be counted: `/observability/tenant-log-volume` and `/observability/tenant-log-facets` count a tenant's request lines and `ctx.log` lines by level, operation and principal kind, and `/observability/tenant-logs` takes repeated `operation` and `principalKind` filters.
