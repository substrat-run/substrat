---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-client': minor
'@substrat-run/connector-woocommerce': patch
'@substrat-run/control-plane': patch
---

One WooCommerce product or order that cannot land no longer stops everything after it. A row the connector cannot read faithfully (a decimal-comma price, a stock count that is not a number) is skipped at once; any other failure on one record holds only its own walk, for three passes, before it is skipped too, and orders keep landing meanwhile. Skipped records are kept with their error, tried again hourly, and cleared when they land. The connection's activity reads "stalled at product 123" or "synced — 2 skipped", with each record's error. `listBindings({ …, health: true })` in `@substrat-run/vertical-host` answers each binding's health — the records it waits at and the ones it skipped — and lists the tenant's connections bound to the scope too, marked `owner: 'tenant'`. The `connectionBindingHealth` schema is in `@substrat-run/contracts`, and `ConnectionScopeBinding` in `@substrat-run/control-plane-client` may carry it.
