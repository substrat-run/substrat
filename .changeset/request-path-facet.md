---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
---

Requests can be counted and filtered by the route that answered them, including requests that reached no operation. The invocation line carries `route` (the method and the registered route pattern, never the called path), the invocation record header and the router's request datapoint (`ROUTER_REQUEST_POINT.route`, blob 11) carry it too, and the tenant request reads take a `path` facet.
