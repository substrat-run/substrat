---
"@substrat-run/contracts": patch
"@substrat-run/control-plane-api": patch
"@substrat-run/docs": patch
---

Prepares the graph store driver's registration. No store driver is registered yet, so a push that declares `driver: 'graph'` is still refused with "declares driver 'graph', which is not registered".

`assertScopeStoresRegistered`, `assertDeclaredScopeStores` and `assertSandboxContract` take the registry they judge against, `STORE_DRIVERS` when none is passed, and the control plane's deploy route and both uploads read its `storeDrivers` option.

Once a driver is registered, a scope whose running version cannot be named, or whose manifest cannot be read, answers 503 before a backup, a full export, a snapshot, a reap, a restore, a subject erasure, the storage gauge or a sweep's wipe only where a version of its vertical has declared a store. A scope of a vertical that never declared one proceeds as it did before stores, and a vertical whose declarations cannot be read still refuses.
