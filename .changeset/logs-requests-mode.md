---
'@substrat-run/dashboard': minor
---

Logs has a Requests mode (#1746): one row per request, with the operation, who ran it, how long it took, its result and how many events it emitted. Above it is a histogram of requests by level over the whole window. Drag across it to zoom, and the bars re-bucket to the narrower window. Beside it is a facet sidebar for operation, problem code, who, status, surface and level. Each facet's counts are what ticking one of its values would give. Ticked values become chips in the query bar, and a row opens that request's own log lines. The counts come from every request in the window, not the bounded sample the Lines mode reads. Requests served by a version deployed before per-request records began are counted as "not recorded".
