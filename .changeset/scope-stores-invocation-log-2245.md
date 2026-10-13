---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
---

An invocation line names the scope-store calls a request made: the binding, the operation, whether it succeeded, and how long it took. The vertical passes nothing. The platform runs each request in an `AsyncLocalStorage`, and a store stub reads the request's record from there. An observer passed to `getScopeStore` still wins, and a call made outside a request is neither logged nor refused. The input is not on the line, and neither is the store's error body. A request that made none keeps the line it had. A request that made more than 16 has its first 16 named and the rest counted in `storeCallsDropped`.

A store operation name is now a fixed label: no `@`, no whitespace, no `:`, at most 64 characters (`storeOperationName`). The door refuses any other name before the call, so it never reaches a line. A kind's catalog is held to the same rule.

The platform entry imports `node:async_hooks`. A wrapped script that has neither `nodejs_als` nor `nodejs_compat` is uploaded with `nodejs_als` appended to its flags. A script that opts out with `no_nodejs_als` keeps its flags, and its line names no store calls.
