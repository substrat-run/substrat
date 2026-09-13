---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
---

The access log now says what was read, on the path every real deployment takes.

Reading a customer's data through the platform has always been recorded. But the record was only complete when the data happened to sit alongside the control plane — and in production it never does: it lives with the app that owns it. On that path the log held only the fact that a scope had been looked up, with nothing about what was then read. Opening an app's summary, paging one of its tables and reading a single record's full history all left the same entry, and the last of those carries the actual contents of events, the person they concern, and the authority the change was made under.

Ten reads now leave the same entry either way: which read it was, what was asked for, and how many rows came back. An auditor cannot tell from the record where the data was served from, which is the point — that was never a distinction the log was meant to be making.

Writing one of those entries is a new capability, and a deliberately small one. The kind of read is drawn from a fixed list, the person it is attributed to comes from the authenticated request and never from anything the caller sends, and neither the timestamp nor the row's identity can be supplied. If the entry cannot be written the read fails rather than returning data whose disclosure went unrecorded — which is the same trade the other path has always made.
