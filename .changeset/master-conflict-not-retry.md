---
'@substrat-run/vertical-auth': minor
'@substrat-run/vertical-host': patch
'@substrat-run/adapter-sqlite': patch
---

A plugin whose master runs several instances in the tenant, with none bound, now answers 409 `conflict` naming the remedy (a tenant admin binds the instance) instead of 503 "retry", both for a person signing in and for a call made for a person (#3436). The person contract gains the refusal `master-conflict`.
