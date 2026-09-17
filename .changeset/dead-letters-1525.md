---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
---

An app's **Flow** view now lists **deliveries that gave up**: every event a handler failed on and will not retry, newest first, with the record it was about, the handler that failed, how many times it ran and the error it threw.

Before, you could only see a failed delivery by opening the event that caused it, so you had to already know which record to look at. A handler inside your app doesn't retry, so a single failure is final, and these are the rows that need someone. Deliveries that are still being retried aren't listed. If the list can't be read, the view says so; it doesn't show an empty list that looks like nothing went wrong.

For platform code, `readDeadLetters` in the kernel is the read behind it: paged, with no payloads. Both hosts expose it as `deadLetters`. The vertical host serves it on `/internal/dead-letters`, and the control plane serves it on `/tenants/:t/scopes/:s/dead-letters`, where each read leaves an access-log row like the other event reads.
