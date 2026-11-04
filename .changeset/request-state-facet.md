---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
---

Requests can be counted and filtered by the process state they moved an entity to. The invocation line carries `processStates` (each lifecycle move as `<entityType>:<state>`, never an id), the invocation record header and the router's request datapoint (`ROUTER_REQUEST_POINT.processStates`, blob 12) carry it too, and the tenant request reads take a `state` facet. A request that made several moves is counted under each one.
