---
'@substrat-run/contracts': minor
---

`clientSafeStoreError` cuts a scope store's error answer to what a client may read, the rule `StoreError` applies. The router now hands a store's own refusal on to the vertical in its envelope, so its `code` arrives as `storeCode` on the platform path too.
