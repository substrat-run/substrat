---
'@substrat-run/control-plane-api': minor
---

Three tenant-grain request reads over the per-request record (#1746). `/observability/tenant-request-volume` gives per-level counts per time bucket over the whole window, `/observability/tenant-request-facets` gives the top values of each facet with every other filter applied, and `/observability/tenant-requests` lists the requests themselves. The facets are level, operation, principal kind, problem code, surface and status. All three take the same tenant, window and facet filters, so the histogram, the counts and the list always describe the same set. They are counted server-side over every request in the window rather than from a sample, and zooming is a narrower window at the same bucket count. The Cloudflare reader implements them with the telemetry API's calculations view. A reader without them answers 501.
