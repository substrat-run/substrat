# @substrat-run/connector-woocommerce

## 0.0.6

### Patch Changes

- ba8a290: A WooCommerce key for another store no longer replaces the store an app is connected to. The platform now tells WooCommerce connections apart by the store each key reads, named by the address the store gives itself, so a key for the same store replaces the old one and keeps the sync where it was, and a key for another store becomes a second connection, listed on its own in the dashboard. A connection made before this holds no store; a key for another store is refused there until it is disconnected.
- f648aa8: One WooCommerce product or order that cannot land no longer stops everything after it. A row the connector cannot read faithfully (a decimal-comma price, a stock count that is not a number) is skipped at once; any other failure on one record holds only its own walk, for three passes, before it is skipped too, and orders keep landing meanwhile. Skipped records are kept with their error, tried again hourly, and cleared when they land. The connection's activity reads "stalled at product 123" or "synced — 2 skipped", with each record's error. `listBindings({ …, health: true })` in `@substrat-run/vertical-host` answers each binding's health — the records it waits at and the ones it skipped — and lists the tenant's connections bound to the scope too, marked `owner: 'tenant'`. The `connectionBindingHealth` schema is in `@substrat-run/contracts`, and `ConnectionScopeBinding` in `@substrat-run/control-plane-client` may carry it.
- d16a696: A store can now connect its own WooCommerce shop. When each install of an app is a store with its own shop, the app connects the shop as that install's own connection and binds it on request, so each install receives only its own shop's products and orders, and never another store's customers. The dashboard lists such a connection on its own install's Integrations tab, marked as its own, and disconnecting it stops only that install's sync. In `@substrat-run/control-plane-api`, a connection inspector can declare `scopeOwned`, and the tenant's verify and credential routes then answer for a scope's own connection through it.
- Updated dependencies [53679f8]
- Updated dependencies [5f0276e]
- Updated dependencies [d08db0d]
- Updated dependencies [2c4a11d]
- Updated dependencies [20cdb03]
- Updated dependencies [d62a936]
- Updated dependencies [eb34bb2]
- Updated dependencies [f648aa8]
  - @substrat-run/contracts@0.200.0
  - @substrat-run/kernel@0.200.0

## 0.0.5

### Patch Changes

- Updated dependencies [cdd061a]
- Updated dependencies [1227128]
  - @substrat-run/contracts@0.199.0
  - @substrat-run/kernel@0.199.0

## 0.0.4

### Patch Changes

- Updated dependencies [e52951e]
- Updated dependencies [a7d4147]
- Updated dependencies [f57381d]
- Updated dependencies [f57381d]
- Updated dependencies [db1b0df]
- Updated dependencies [70d8dc5]
- Updated dependencies [f57381d]
- Updated dependencies [e52951e]
  - @substrat-run/contracts@0.198.0
  - @substrat-run/kernel@0.198.0

## 0.0.3

### Patch Changes

- Updated dependencies [7b93798]
- Updated dependencies [2fd76c2]
  - @substrat-run/kernel@0.197.0
  - @substrat-run/contracts@0.197.0

## 0.0.2

### Patch Changes

- Updated dependencies [12933eb]
- Updated dependencies [8757b2c]
- Updated dependencies [77ce7f0]
  - @substrat-run/contracts@0.196.0
  - @substrat-run/kernel@0.196.0
