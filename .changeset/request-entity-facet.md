---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
---

Requests can be counted and filtered by entity type. The invocation line carries `entityTypes` (the sorted distinct entity types its events were about), the invocation record header and the router's request datapoint (`ROUTER_REQUEST_POINT.entityTypes`, blob 10) carry it too, and the tenant request reads take an `entity` facet. A request touching several types is counted under each one.
