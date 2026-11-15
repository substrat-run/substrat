---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

An operation refused for a missing entitlement no longer tells the caller every entitlement key the tenant holds (#3105). The refusal is still `not_found`, and its `detail` is now `operation not entitled: <operation> — tenant does not hold '<key>'`, with no `; holds: …` list. The required-vs-held diagnosis (#691), expired keys marked, moves to a server-side `entitlement-denied` warn line keyed by the request id (`x-substrat-request-id`), written by all three gates: the Cloudflare coordinator, the scope Durable Object and the SQLite adapter. `entitlementDenial(operation, requiredKey)` drops its third argument; `refuseEntitlement` and `entitlementDenialLine` are new.
