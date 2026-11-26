---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
'@substrat-run/connector-fortnox': minor
'@substrat-run/control-plane': patch
'@substrat-run/dashboard': patch
---

A store can now connect its own Fortnox company. When each install of an app is a store that keeps its own books, the app starts the consent round from the store with `owner: 'scope'` (`requestConnectUrl`), and the round ends in that install's own connection, bound to that install alone, so each store lands only its own company's ledger. A re-consent of the same company from the same store rotates its connection, and the same company connected from another store is that store's own. The dashboard lists the connection on its install's Integrations tab, marked as its own, and disconnecting it stops only that store's sync. A Fortnox connection made from the dashboard or a connect link stays the tenant's, as before. In `@substrat-run/control-plane-api`, the connect-url relay takes `owner: 'scope'`, and `POST /tenants/:tenantId/connections/consented` stores and binds a scope's own round after verifying its signed state.
