---
'@substrat-run/contracts': minor
'@substrat-run/control-plane': patch
'@substrat-run/dashboard': patch
---

A WooCommerce store can be connected from the dashboard with its URL and a Read REST API key. Its products and orders land in your app every quarter of an hour, through the operation the app declares, as `commerceChange` records: a provider-neutral commerce shape in `@substrat-run/contracts`, so another store platform's connector can feed the same operation. Test connection tells a wrong address from a wrong key and names the store. Read-only; stock, deletes and write-back are not in this release.
