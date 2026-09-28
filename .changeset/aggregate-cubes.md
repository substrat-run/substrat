---
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
---

The tenant log reads now scale with traffic rather than with views (#1877). The request histogram, facet counts and log patterns are computed from cubes: counts for one app script and one span, grouped by tenant and every facet. Each closed span is counted once and kept, in a new `ObservabilityCacheDO` with one object per script, and only the open span is read live, so later viewers of any tenant read counts without a query. Every tenant log read is also scoped to the app's own scripts, which bounds what a query scans and counts only lines the app's script wrote. A telemetry timeout now reaches the caller as a 504 saying so. The routes and their response shapes are unchanged.
