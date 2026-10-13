---
'@substrat-run/contracts': patch
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/cli': patch
'@substrat-run/docs': patch
---

The control plane now refuses a vertical's own durable-object binding that takes a per-tenant or scope store's name, as the push already did. Both use `storeNamesOfBindings`. A scope store's error envelope is read only with a status from 400 to 599, and a `StoreError` carries the store's body to a client only for a 4xx whose JSON is at most 1 KiB (`STORE_BODY_MAX_BYTES`). Both adapters start and stop scope-store runners through `scopeStoreLifecycleOf`. A retried start no longer starts a runner twice, and `close` calls `stop` on every runner even when one throws.
