---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-client': minor
'@substrat-run/cli': minor
---

The code that backs a scope store is now called its **driver** (K-53), where it was its kind. This is a clean break with no alias. No driver has been registered yet, so no push could declare a scope store and no store script was ever uploaded. Nothing deployed depends on the old names.

- **Declaration:** `runtimeNeeds.scopeStores: [{ binding, driver }]`. A declaration that still spells `kind` is refused with `scopeStores[].kind was renamed driver`, by the manifest parser and so by `substrat push`. A scope dump's `stores[].driver` is the same: a dump store that still spells `kind` is refused with the rename named, and a dump with no stores loads unchanged.
- **Contracts:** `storeKindId` → `storeDriverId`, `STORE_KINDS` → `STORE_DRIVERS`, `STORE_KIND_ID` → `STORE_DRIVER_ID`, `storeKindRegistration` → `storeDriverRegistration` (its field `kind` → `driver`), `StoreKindRelease*` → `StoreDriverRelease*`, `storeKindReleaseDigest` → `storeDriverReleaseDigest`. The admin actions are `uploadStoreDriverRelease`, `rollOutStoreDriver` and `rollBackStoreDriver`. The three old names stay readable as `HISTORIC_ADMIN_ACTIONS`, so an existing log still parses, and no host writes them.
- **Kernel and adapters:** the `HostAdmin` methods are `recordStoreDriverRelease`, `getStoreDriverRelease`, `storeDriverState`, `storeDriverDeclarations`, `holdStoreDriver`, `releaseStoreDriverHold`, `beginStoreDriverRollout` and `finishStoreDriverRollout`, and each takes `driver`. `ScopeStoreRunner.kind` is `driver`, and the host option `scopeStores.kinds` is `scopeStores.drivers`. The directory tables are `store_driver_releases`, `store_driver_rollouts`, `store_driver_current` and `store_driver_holds`, keyed by `driver`, and `vertical_scope_stores.kind` is `driver`. A directory built before the rename is moved onto these names on its next start, rows kept. A directory restore maps an older dump's names the same way, and it refuses a dump that holds a table under both names.
- **Control plane:** the routes are `/store-drivers/:driver`, `/store-drivers/:driver/releases`, `/store-drivers/:driver/rollouts` and `/store-drivers/:driver/rollback`. The builder client's methods are `getStoreDriver`, `uploadStoreDriverRelease`, `rollOutStoreDriver` and `rollBackStoreDriver`.
- **CLI:** `substrat store-kind … --kind <kind>` is now `substrat store-driver … --driver <driver>`. The old command and the old flag each exit naming the new one.
- **Release bundles:** a release bundle's package is `driver_<name>/` instead of `kind_<name>/`. The store entry's import placeholder is `__SUBSTRAT_STORE_DRIVER__`.

What did not change: a store script is still `substrat-store-<driver>-<vertical>`, with the driver id in the same position and the same `[a-z0-9]+` grammar, and its canary script is still `substrat-store-<driver>--canary`. Release bytes are still stored under `<driver>/<sha256>`. Both strings keep the shape they had, because the driver id is the value the kind id was. `tenantStores: [{ binding, kind: 'relational' | 'blob' }]` is a different concept, and it keeps its `kind`.
