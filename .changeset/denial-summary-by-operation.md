---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
---

The denial summary can bucket per operation (#1456). `denialFilter` takes an optional
`groupBy: 'actor-permission' | 'operation'`; with `operation`, `summarizeDenials` and
`GET …/denials/summary` answer one `{ operation, count, firstAt, lastAt }` bucket per
operation, busiest first, with the same `total` and filter-free window facts beside it.
`operation` is nullable in that bucket: refusals that unwound no operation invocation are
one `null`-keyed bucket, counted toward `total` rather than dropped.
The answer echoes the grouping it carries as `groupBy`, so `DenialSummary` is now a
discriminated union on that field — a consumer narrows on it before reading a bucket's
fields. Absent `groupBy`, the (actor, permission) buckets are unchanged. The dashboard's
per-operation health panel reads the aggregate instead of counting from a capped page.
