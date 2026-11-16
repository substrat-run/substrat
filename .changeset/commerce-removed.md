---
'@substrat-run/contracts': minor
---

Commerce sources can report a product or order that left the store: `commerceChange` now carries `change: 'removed'` with `removal: 'trashed' | 'deleted'` and `observedAt`, keyed by the same `productId` or `orderId` as its upserts. Code that narrows a `CommerceChange` on `record` alone now narrows on `change` too.
