---
'@substrat-run/contracts': patch
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

An entity-narrowed permission check that walks through a camelCase entity type (`aiTurn`, `widgetSession`) now answers instead of throwing (#1856). The tuple grammar `objectRef` accepts an upper-case letter in the namespace half; nothing it accepted before is refused.

`ctx.link`, `ctx.grant`, `ctx.capabilities.mint`, `HostAdmin.grant` narrowed onto an entity, and `grantEntityLocal` now refuse a malformed entity ref when it is written, with `validation_failed` (error name `Substrat.validation_failed`, HTTP 400). A ref is malformed when its `entityType` is empty or has anything other than letters, digits, `_` and `-` (a colon, whitespace, a dot, non-ASCII), or its `entityId` is empty or has whitespace. `ctx.revoke` does not check the grammar, so a grant stored earlier can still be removed. Refs already stored are not rewritten, and every stored ref the walk could read before still reads the same way. New export: `entityObjectRef` from `@substrat-run/contracts`.
