---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

`getScope` takes `delegation: { actor, scope }` for a person acting through another app: the delegated scope caps every permission decision the call makes and keys its own idempotency recordings, on both adapters, with a contract suite holding them to it (#3161).
