---
'@substrat-run/control-plane-api': minor
'@substrat-run/connector-woocommerce': patch
'@substrat-run/control-plane': patch
'@substrat-run/dashboard': patch
---

A store can now connect its own WooCommerce shop. When each install of an app is a store with its own shop, the app connects the shop as that install's own connection and binds it on request, so each install receives only its own shop's products and orders, and never another store's customers. The dashboard lists such a connection on its own install's Integrations tab, marked as its own, and disconnecting it stops only that install's sync. In `@substrat-run/control-plane-api`, a connection inspector can declare `scopeOwned`, and the tenant's verify and credential routes then answer for a scope's own connection through it.
