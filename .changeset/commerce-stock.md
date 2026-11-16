---
'@substrat-run/contracts': minor
---

A commerce variant can carry its `stock`: whether the store counts it (`manageStock`), the `quantity` (`null` when it does not, never `0`), a `status` of `in_stock`, `out_of_stock` or `on_backorder`, the store's own word, and `sharedWithProduct` when one count covers every variant. Optional, so existing producers and consumers are unaffected.
