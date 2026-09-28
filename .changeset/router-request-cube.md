---
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
"@substrat-run/control-plane-api": minor
---

The request histogram and facets can read the router's Analytics Engine datapoints instead of scanning Workers Logs (#1904). The platform entry hands a routed request's operation, problem code and principal kind back to the router on `x-substrat-invocation-record`; the router writes them into its datapoint and strips the header. `createCfObservabilityReader` takes `requestsFromRouterSince`, the instant from which request reads come from the router's dataset; before it, and when it is unset, they come from Workers Logs as before. `invocationLevelOf` moves to `@substrat-run/contracts/invocation-record` and is still exported from the kernel.
