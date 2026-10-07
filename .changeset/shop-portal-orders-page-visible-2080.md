---
'@substrat-run/demo-shop': patch
---

`shop/portal-orders` now walks the order table with `pageVisible` (#2080). It used to read every order in the scope and check each one before cutting a page, so one portal request cost one permission check per order the shop had ever taken. Now a page costs the checks it takes to fill it, and at most `VISIBLE_SCAN_BUDGET` rows a call. The cursor is still only ever one of the caller's own orders. The order is unchanged: newest first, by order number. A customer whose next order lies more than the budget past their previous one gets a short page and no cursor, which is `pageVisible`'s documented limit (#2074). `GET /api/portal/orders` now passes `limit` and `cursor` on to it, so following its `Link` header reaches the next page; before, it answered page one again.
