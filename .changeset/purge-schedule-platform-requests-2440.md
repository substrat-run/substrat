---
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

A purge-horizon schedule's run now reports the platform requests its purges enqueued, on the Durable Object adapter as it already did on the SQLite one (#2440). `PurgePass` gains an optional `platformRequests`; the scope sums what each committed purge enqueued, so the sweep that ran the schedule can drain the scope in the same pass rather than leaving those requests a sweep interval.
