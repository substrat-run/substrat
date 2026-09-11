---
'@substrat-run/docs': patch
---

substrat.net now has a **book** — ten chapters meant to be read in order, front to back,
rather than arrived at with a question. The rest of the site is a reference, and a
reference never says how the pieces join: which thing calls which, what happens between a
request landing and a row being written, who retries what when it fails.

The chapters that carry genuinely new material are the ones the reference had no home for.
**The path of one request** walks every hop from hostname to SQL and back — the router's
trust boundary, dispatch, the lifecycle gates, lazy migration on wake, the per-scope queue,
the transaction. **The life of one event** follows `ctx.emit` into the outbox, through the
post-commit dispatch loop, to a consumer's own transaction — including that an in-scope
consumer **does not retry**, where an executor does, with backoff and a dead letter. **The
two clocks** finally puts the platform sweeper and the vertical's own scope sweeper side by
side, names every phase of the fleet pass in order, and says plainly that nothing reaps an
archived scope's storage unless a retention window has been configured, because Cloudflare
never garbage-collects a Durable Object.

It is also published in one file — `/book.txt` for printing, `pandoc`, or handing to a
model in one shot, and `/book/read.html` as a single scrolling, printable page. Both are
generated from the chapters at build time from the same list the nav reads, so there is no
second copy to fall behind.
