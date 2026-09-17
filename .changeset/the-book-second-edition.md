---
'@substrat-run/docs': patch
---

The book on substrat.net has a second edition, with thirteen chapters. Three are new.
**Seeing what happened** covers the four observability instruments: sampled router traffic,
tenant-stamped invocation logs, opt-in traces, and the event spine read through record history,
*Why?*, *What did it do?* and *Same call*. It also says which question each one can answer.
**The audit trail and the lake** separates the outbox, the denial log, the admin log and the
access log, then follows events out of their scope into an Iceberg table in R2 that R2 SQL can
query. It is plain about what is not built there yet: a query gateway, tenant scoping, and
erasure. **Metering and billing** keeps apart a vertical billing its own customers with the
metering and invoicing engines and the platform metering a tenant, and it says that storage is
not counted yet.

The existing chapters answer questions readers of the first edition asked. Chapter 1 now has a
glossary (module, the spine, executor, connector, platform intent). Chapter 4 explains why plain
SQL with no query builder is safe enough and where it is not, why timestamps are fixed-width
text, and what a slow `await` holds: its own scope, never another. Chapter 5 explains the kick
that runs a platform intent in seconds instead of at the fifteen-minute sweep, and what a
vertical has to wire for it. The chapters also catch up with what has shipped since the first
edition: the MCP surface, invocation ids on events, the lake drain phase, the dashboard's four
tabs, and todo and ticket0 as the reference verticals. `/book.epub`, `/book.txt` and
`/book/read.html` carry all of it.
