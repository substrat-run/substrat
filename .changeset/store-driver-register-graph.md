---
"@substrat-run/contracts": patch
"@substrat-run/control-plane-api": patch
"@substrat-run/cli": patch
"@substrat-run/control-plane": patch
"@substrat-run/docs": patch
---

The graph store driver is registered with its first pinned release. The release bytes are not uploaded, and no vertical is served by the pin until they are.

`substrat push` and the control plane's deploy route no longer refuse a vertical that declares `driver: 'graph'` as unregistered (403). Until a release of the driver is uploaded and rolled out, that push is refused later, at the store-script upload: 409 when no release is rolled out, 501 on a control plane that uploads no store script.

With a driver registered, the control plane judges every scope's stores before a backup, a full export, a snapshot, a reap, a restore, a subject erasure, the storage gauge or a sweep's wipe. A scope whose running version cannot be named, or whose manifest cannot be read, now answers 503 there instead of skipping a store it may hold. The scheduled store-script rebuild runs for the graph driver.

`assertScopeStoresRegistered`, `assertDeclaredScopeStores` and `assertSandboxContract` take the registry they judge against, `STORE_DRIVERS` when none is passed, and the control plane's deploy route and both uploads read its `storeDrivers` option.
