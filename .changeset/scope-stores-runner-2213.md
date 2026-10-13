---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

A scope-store kind can ship a runner: `kind`, `start`, `stop`, and `invoke(address, request)` where the address is the tenant, the vertical, the scope and the binding. The pure adapter binds those runners on the host. The Cloudflare adapter uses a runner when one is configured and the injected binding otherwise. The same contract suite runs on both: a declared binding reaches its object, an undeclared binding is refused, two scopes do not share an object, two verticals do not share an object, and a reserved operation is refused by the stub.
