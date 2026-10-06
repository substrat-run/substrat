---
'@substrat-run/contracts': minor
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': minor
'@substrat-run/vertical-host': patch
'@substrat-run/create-substrat': patch
---

`pageVisible` no longer hands a caller the position of a row it may not see (#2073). It used to return the cursor of the last row it EXAMINED, and a cursor carries its row's id and sort value, so a per-row-filtered read with `limit: 1` told a caller the id and sort value of every row the check refused. Every portal walk and the scaffold template used it.

It now walks on past refused rows until it has `limit` visible ones or reaches the end, and mints the cursor from the last visible row of a full page. One call reads at most `VISIBLE_SCAN_BUDGET` (2 000) rows. A page that stops short of `limit`, at the end or at the budget, answers the same way: the visible rows it found and a null cursor. So a short page now ends the walk, which is `pageOf`'s rule again. The cost: a caller whose next visible row lies more than the budget past their previous one never reaches it, and is told the walk ended. A sealed continuation that carries the walk on without revealing a position is #2074.

`pageVisible` reads in batches of `max(limit, VISIBLE_BATCH)` (64), so a sparse walk costs about `budget / 64` reads rather than one per refused row. A page may now carry each row's own cursor as `rowCursors`, aligned with `entries`, when the read is asked for it with `rowCursors: true`: `pageOf`, `countedPageOf`, `mapPage` (by index, so rows that map to equal values keep their own) and `ctx.page` on both adapters. `pageVisible` asks for them. When its page fills partway through a batch, it reads that visible row's cursor off the same response, so it survives an RPC and no concurrent write can change it. A fetch that returns no `rowCursors` ends the walk at that row with a null cursor, as a short page does. It is never read a second time. Pass the walk's params on (`{ ...input, ...p }`) and that never happens. An ordinary page is unchanged.

`pageVisible` never returns `rowCursors`. A handler that filtered `entries` after its read would leave them naming the rows it dropped, so `@substrat-run/vertical-host` strips them from every wire projection: the HTTP body, a vertical's `respond`, and an MCP tool result. It does this with the new `withoutRowCursors` from contracts.

`pageVisible` grows two optional parts. The test may be `{ batch }`, one verdict per row for a whole batch, for a proof cheaper asked of a set. A fourth `options` argument takes `scanBudget`. `fetch` may now be async.

`@substrat-run/contract-tests`: the `ctx.page` suite now asserts three things on every adapter. Each row's `rowCursors` entry resumes the walk right after that row, on a tied sort and on a counted page. An ordinary page carries none. A host-side `pageVisible` walk across invokes, with rows written between calls, neither leaks a refused row's position nor skips a visible row.

`ctx.pageTrashed` is now this same walk with the declared trash key as its check, so the two cannot drift apart. `TRASH_SCAN_BUDGET` is `VISIBLE_SCAN_BUDGET`. The scaffold template's comment on its portal walk says what the walk now does.
