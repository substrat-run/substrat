---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
---

The signals dimension vocabulary lands (#1231): `@substrat-run/contracts` gains
`SIGNAL_DIMENSIONS` and `signalStamp` — the one set of names
(`tenant / scope / vertical / version / operation / eventType / connection`) every
observability-facing record is stamped with, defined once so a chart, a failure list and
a graph node all mean the same thing by `version` and an aggregate can click through to
its exemplars with filters intact.

Two facts move under it immediately. Ops-failure rows (#559) now carry the `version`
dimension — the version-registry id the failure happened under, stamped at the preview,
provision and intent-drain write sites, filterable via `listOpsFailures` and
`GET /ops-failures?version=…`, with an old row's NULL reading as "predates the stamp" —
which is what lets a failure be read against the push that produced it. And the
observability seam's `RecentLogEvent.eventType` (the Workers invocation shape:
`fetch`/`rpc`/`scheduled`) is renamed `invocation`, because the vocabulary reserves
`eventType` for a DOMAIN event's type and that field was the one place the two could be
confused in a filter.
