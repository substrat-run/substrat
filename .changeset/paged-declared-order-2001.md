---
'@substrat-run/contracts': patch
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/vertical-host': patch
'@substrat-run/contract-tests': patch
---

A paged read is now served in the order it declares. An operation declaring `paged: { …, order: 'desc' }` used to be served oldest-first whenever the caller named no order, while its OpenAPI document said newest-first. The declared order is now the default over HTTP, over MCP and in process alike, on both adapters, and an explicit `order` still wins. `operationInputsOf` applies it, so a module wired with `operationInputs` needs no change. The MCP tool schema now states a declared order as its default.

A kernel-composed page's `nextCursor` now names the walk that minted it (`<order>.<sort>.<position>`). It is still opaque: hand it back, or follow the `Link` header. A cursor replayed under a different sort or order is refused with `validation_failed` and `reason: 'cursor_restart'` (`PAGE_CURSOR_RESTART`, exported from `@substrat-run/contracts`), which means read the first page again, rather than answered with rows the caller has already read. A cursor minted before this release continues in the ascending default walk it came from and is refused anywhere else, so a descending walk in flight across the upgrade restarts once. `CursorMismatch` is exported from `@substrat-run/kernel`, and `validation_failed` problems may now carry a `reason`.
