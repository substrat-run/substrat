---
"@substrat-run/control-plane-api": patch
---

fix(control-plane-api): drained provisioning targets the serving script, and a stuck intent gives up honestly (#570)

The acme provision-tenant intent retried every sweep for six days (577 attempts)
because the handler's two halves aimed at two different scripts: the tenant-store
D1 binding was patched onto the vertical's stable SERVING script, while the
provision call dispatched through the scope's pinned version to the per-version
script — which has no store bindings, so the vertical refused "no tenant store
attached" forever. A still-provisioning scope that lacks its serving pointer while
its vertical serves in place is now stamped onto the serving script (serving ref +
version pointer) before the client resolves, on both the provision-tenant and
provision-sibling paths — safe exactly because such a scope has never activated,
so there is no data to hop. The stranded acme scope converges on its next drain
pass with no manual adopt-serving.

And a structurally-stuck intent no longer pretends to be transient forever: at
`MAX_PLATFORM_REQUEST_ATTEMPTS` (100 passes ≈ a day at sweep cadence) the drain
settles it `failed` carrying its last real error — what the proposer's read
actually surfaces — and lands a durable ops-failure row (#559) for the operator,
instead of burning an attempt every 15 minutes visible only to someone reading
`_substrat_platform_requests` by hand.
