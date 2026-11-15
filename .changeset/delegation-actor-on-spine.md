---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

A call made for a person through another app (`getScope(…, { delegation })`) now records which app acted: every event it emits and every denial it writes carry `delegation: { actor }`, in a new nullable `delegation` column on `_substrat_outbox` and `_substrat_denials` that existing scopes gain on their next wake (#3176). `readHistory`, `readScopeHistory` and the denial reads return it, with `null` meaning nobody acted for anyone; a consumer's or a schedule's emit never carries it. The event envelope carries it as an optional `delegation`, and the lake stream schema declares the column.
