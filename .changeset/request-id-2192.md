---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/vertical-host': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
'@substrat-run/control-plane-api': patch
---

Every response to a stamped request now names its request (#2192).

The id the platform mints for a request, the invocation id the dashboard's request view opens, goes out as an `x-substrat-request-id` header (`REQUEST_ID_HEADER`) on every response the request gets. That covers an operation's answer, a refusal, an error the envelope rendered, a vertical's own routes and a response passed straight through. The platform's entry sets it, so a hosted vertical carries it after the next control-plane deploy without a new push, and the `invocationLog` middleware sets it where no platform entry runs.

A problem body rendered for such a request carries the same value as `requestId`. That includes a refused permission's 403, which `mountOperations` answers through `mountPlatformSurface`'s envelope, and a vertical's own `problemResponse`. It is a new optional member of the `problem` schema, so every published OpenAPI document gains it.

Module code reads the same id as `ctx.requestId`: the request's id in an operation, the originating request's id in a consumer, the run's id in a schedule, and `null` on an in-process call that carried none. Harness code reads it as `requestIdOf(c)`. The id is opaque, and a request nothing stamped answers exactly as before.
