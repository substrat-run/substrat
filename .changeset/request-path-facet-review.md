---
'@substrat-run/vertical-host': patch
'@substrat-run/control-plane-api': patch
---

A request's route is always the pattern that answered it: a value a handler writes into the invocation record is replaced, and `InvocationRecord.route` is read-only. An upgrade (101) response no longer carries the invocation record header, which the router cannot strip from one. The tenant request reads refuse a `path` facet value that is not a route (`<METHOD> <pattern>`).
