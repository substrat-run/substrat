---
"@substrat-run/control-plane": patch
"@substrat-run/dashboard": patch
---

A WooCommerce connection writes back now: an app that emits `woocommerce.stock-set-requested` or `woocommerce.order-complete-requested` has the stock count set, or the order marked completed, at the store within seconds, and the record lands again as it now stands. The write goes through the store connection bound to the asking install only, and needs a Read/Write key; the dashboard's WooCommerce card says so.
