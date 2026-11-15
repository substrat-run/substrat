---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

`getScope` takes `delegation: { actor, scope }` for a person acting through another app: the delegated scope caps every permission decision the call makes and keys its own idempotency recordings, on both adapters, with a contract suite holding them to it (#3161). With `via`, the call arrived through that peer and also passes its admission, on every invoke: declared in `peers` and switched on, so `revokeFromPeer` stops it too.
