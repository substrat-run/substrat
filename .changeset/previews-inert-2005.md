---
'@substrat-run/kernel': minor
'@substrat-run/contracts': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane': minor
'@substrat-run/router': minor
'@substrat-run/vertical-egress': minor
---

Previews and forks are inert: a scope that is not primary causes no outbound effects (#2005).

A fork, a snapshot and a preview of either kind still run their code and commit their writes, but nothing they ask for leaves them. One predicate decides it, `isPrimaryScope`, and every outbound door applies it:

- The platform-intent drain settles a non-primary scope's own intents `failed`, attributed to the platform, with the new `INERT_SCOPE_REASON`, and runs no handler. The settle lands no ops-failure row. `model-usage` and `sweep-runs` still land, because they record something that already happened. `drainScopePlatformRequests` now takes a `PlatformDrainContext`, which requires the scope's `kind` and `forkedFrom`, and decides from them.
- Executor and connector dispatch, on both adapters (the emitting call's tail and `drainDue`), journals a non-primary scope's deliveries terminal with the same reason and never runs the handler. `ExecutorDrainReport` gains an optional `inert` count. A CP-less hosted vertical, which has no directory, reads the scope's own copy-origin row instead. Every copy now holds that row, an empty copy included.
- `RouteTarget` gains `primary` (defaulted to `true` for a resolver that predates it). `RouteTarget` also gains `hostnames`, the scope's active hostnames, defaulted to `[]`. The router hands all of it, with the hostname the dispatch serves, to the egress worker. The worker refuses every third-party subrequest from a non-primary scope, and every write to another platform app, metering both as `inert`. Reads of other apps, any request to a hostname of the copy's own scope, and the relay still pass.
- The sweep's schedule and freshness phases filter on `isPrimaryScope`, so a clean-room preview no longer fires its schedules.
- Previews and forks cannot send email or change a tenant's connections: the email relay, the connection relay (including the route a consent round's callback stores through) and connect-url refuse a non-primary scope with a 403.
- `isPrimaryScopeRow` answers the same predicate over a raw directory row.
