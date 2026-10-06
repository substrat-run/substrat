---
'@substrat-run/contracts': minor
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': minor
'@substrat-run/vertical-host': minor
'@substrat-run/create-substrat': patch
---

`pageVisible` no longer hands a caller the position of a row it may not see (#2073). It used to return the cursor of the last row it EXAMINED, and a cursor carries its row's id and sort value, so a per-row-filtered read with `limit: 1` told a caller the id and sort value of every row the check refused. Every portal walk and the scaffold template used it.

It now walks on past refused rows until it has `limit` visible ones or reaches the end, and mints the cursor from the last visible row of a full page. One call reads at most `VISIBLE_SCAN_BUDGET` (2 000) rows. A page that stops short of `limit`, at the end or at the budget, answers the same way: the visible rows it found and a null cursor. So a short page now ends the walk, which is `pageOf`'s rule again. The cost: a caller whose next visible row lies more than the budget past their previous one never reaches it, and is told the walk ended. A sealed continuation that carries the walk on without revealing a position is #2074.

`pageVisible` reads in batches of `max(limit, VISIBLE_BATCH)` (64), so a sparse walk costs about `budget / 64` reads rather than one per refused row. A page may now carry each row's own cursor as `rowCursors`, aligned with `entries`, when the read is asked for it with `rowCursors: true`: `pageOf`, `countedPageOf`, `mapPage` (by index, so rows that map to equal values keep their own) and `ctx.page` on both adapters. `pageVisible` asks for them. When its page fills partway through a batch, it reads that visible row's cursor off the same response, so it survives an RPC and no concurrent write can change it. A fetch that returns no `rowCursors` ends the walk at that row with a null cursor, as a short page does. It is never read a second time. Pass the walk's params on (`{ ...input, ...p }`) and that never happens. An ordinary page is unchanged.

`pageVisible` never returns `rowCursors`, and no external caller ever sees or sets them. `@substrat-run/vertical-host` adds one door, `wire.ts`, and every external transport goes through it: the HTTP mount (paged and whole), MCP, a peer vertical's call, the connector write-back and the exported-events read.
- `externalInput` drops a caller's `rowCursors` flag.
- `externalJson` is `c.json` with a `JSON.stringify` replacer that scrubs every PAGE in the result (an `entries` array and a `nextCursor` key) of its `rowCursors`, at any depth. It is one serialisation, so what is scrubbed is exactly what reaches the wire: repeated references, class instances and `toJSON` included. A `rowCursors` property on anything that is not a page, such as a domain field or an opaque record, is left as it is.
- `externalResult` is the same scrub as a round trip, for MCP's structured content.

Contracts exports the replacer pieces: `ROW_CURSORS_KEY`, `rowCursorsReplacer`, `serializeWithoutRowCursors` and `withoutRowCursors`. The scaffold template's hand-written `/api/invoke` route goes through the same door, so a scaffolded vertical starts with it. A vertical's own `respond` envelope is handed the result untouched, as before. `rowCursors` travel only inside a scope and over the host↔scope `invoke`.

`pageVisible` grows two optional parts. The test may be `{ batch }`, one verdict per row for a whole batch, for a proof cheaper asked of a set. A fourth `options` argument takes `scanBudget`. `fetch` may now be async.

`@substrat-run/contract-tests`: the `ctx.page` suite now asserts three things on every adapter. Each row's `rowCursors` entry resumes the walk right after that row, on a tied sort and on a counted page. An ordinary page carries none. A host-side `pageVisible` walk across invokes, with rows written between calls, neither leaks a refused row's position nor skips a visible row.

`ctx.pageTrashed` is now this same walk with the declared trash key as its check, so the two cannot drift apart. `TRASH_SCAN_BUDGET` is `VISIBLE_SCAN_BUDGET`. The scaffold template's comment on its portal walk says what the walk now does.
