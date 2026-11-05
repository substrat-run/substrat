---
'@substrat-run/adapter-cloudflare': minor
---

A control-plane-less host refuses every door into a scope whose tenant is not recorded (no provision receipt and no role rows) with the same `not_found` a mismatched (tenant, scope) pair gets, instead of admitting it with a `tenant-unrecorded` warn line; the ownerless reconcile now records the platform's tenant on such a scope, as a full reconcile and a lifecycle delivery do.
