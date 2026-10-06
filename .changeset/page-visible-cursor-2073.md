---
'@substrat-run/contracts': minor
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': minor
'@substrat-run/create-substrat': patch
---

`pageVisible` no longer hands a caller the position of a row it may not see (#2073). It used to return the cursor of the last row it EXAMINED, and a cursor carries its row's id and sort value, so a per-row-filtered read with `limit: 1` told a caller the id and sort value of every row the check refused. Every portal walk and the scaffold template used it.

It now walks on past refused rows until it has `limit` visible ones or reaches the end, and mints the cursor from the last visible row of a full page. One call reads at most `VISIBLE_SCAN_BUDGET` (2 000) rows. A page that stops short of `limit`, at the end or at the budget, answers the same way: the visible rows it found and a null cursor. So a short page now ends the walk, which is `pageOf`'s rule again. The cost: a caller whose next visible row lies more than the budget past their previous one never reaches it, and is told the walk ended. A sealed continuation that carries the walk on without revealing a position is #2074.

`pageVisible` reads in batches of `max(limit, VISIBLE_BATCH)` (64), so a sparse walk costs about `budget / 64` reads rather than one per refused row. When the page fills partway through a batch, the cursor is minted from that visible row by the page's producer. `pageOf`, `countedPageOf`, `mapPage` and `ctx.page` on both adapters now attach a mint for every row they return, read with the new `pageCursorOf(page)`. It is a non-enumerable property, so it never reaches the wire, a structured clone, a spread or a `toEqual`. A fetch whose page has no mint is asked once more, up to that row.

`pageVisible` grows two optional parts. The test may be `{ batch }`, one verdict per row for a whole batch, for a proof cheaper asked of a set. A fourth `options` argument takes `scanBudget`. `fetch` may now be async.

`@substrat-run/contract-tests`: the `ctx.page` suite now asserts that each row's minted cursor resumes the walk right after that row, on a tied sort and on a counted page.

`ctx.pageTrashed` is now this same walk with the declared trash key as its check, so the two cannot drift apart. `TRASH_SCAN_BUDGET` is `VISIBLE_SCAN_BUDGET`. The scaffold template's comment on its portal walk says what the walk now does.
