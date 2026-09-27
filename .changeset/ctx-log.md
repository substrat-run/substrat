---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

`ctx.log` — a structured logger for module code (#1746, #1747). `ctx.log.info('reply to {ticketId} sent', { ticketId })` writes one JSON line. The host stamps it with the tenant, scope, operation, invocation id and the kind of subject the code ran as. The line also carries the template it was written from, so every line from one call site shares it. That is what the log patterns and operation filters planned in #1747 will read; this release only writes the lines. Consumers get it too, and their lines say `system` and name no operation. A call never throws: oversized values are trimmed, non-primitive fields are stringified, and a capability secret minted in the same call is withheld. Lines are not transactional, so a rolled-back operation's line is kept. `SqliteScopeHostOptions.logSink` redirects the lines (a test passes a collector); the default, and the Durable Object host, write them to the console. Both adapters pass the new `moduleLogContractSuite`.
