---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': minor
'@substrat-run/dashboard': minor
---

Async work writes an invocation line (#1901). A consumer delivery, each retry, a dead-letter and a schedule run used to write nothing, so a consumer that failed every attempt showed only as a dead-letter count.

- The scope host writes one line per unit of work, in the request line's shape plus `kind: 'consumer' | 'schedule'`. A request's line still has no `kind`; read a missing one as `request`. Both lines are built by the new `invocationLine`, so they share one grammar.
- A consumer's line (a module consumer, an executor, or an imported event's handler) names the consumer as `operation` and carries `eventType`, `eventId`, `attempt` and `outcome`: `delivered`, `retrying`, `dead-lettered`, `inert` (a copy's held delivery, at `warn`) or `routed`. A schedule's line carries `dueAt` and `latenessMs`, with `outcome` `ok` or `failed`.
- Ids, names and the thrown error's `errorCode` only. No payload, and no error text.
- A unit in a call's tail logs under the call's id. A unit outside any call logs under an id minted for it, and its `ctx.log` lines carry the same id.
- A pass writes at most `ASYNC_LINES_PER_PASS` (100) lines, then one `suppressed` line that counts the rest per `<kind>:<outcome>`.
- `SqliteScopeHostOptions.invocationLineSink` redirects the lines; the default, and the Durable Object host, write them to the console. Both adapters pass the new `asyncLogContractSuite`.
- `InvocationLogLine.method` and `.path` are now `string | null`; they are `null` on an async line.
- The control plane's request reads gain a `kind` facet (`REQUEST_FACET_KEYS`), and each `RequestRecord` carries `kind`, `outcome`, `eventType`, `eventId`, `attempt` and `latenessMs`. The telemetry cube groups by `kind`. Past the router cut-over, the request cube adds the async lines the router never meters (`AggregateSource.asyncRequests`).

These lines ship inside the vertical's adapter, so a vertical writes them after it upgrades and pushes again, not on a platform deploy.
