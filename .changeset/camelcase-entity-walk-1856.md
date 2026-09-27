---
'@substrat-run/contracts': minor
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

An entity-narrowed permission check that walks through a camelCase entity type (`aiTurn`, `widgetSession`) now answers instead of throwing (#1856). The tuple grammar `objectRef` accepts an upper-case letter in the namespace half; nothing it accepted before is refused. Edges and grants already stored on a camelCase type (from `ctx.link`, `ctx.grant`, `HostAdmin.grant`, `grantEntityLocal`, or a capability's root) now take effect, where before a check that reached them threw. An event's `authorization[].grant` (K-34) takes the same grammar, so an operation authorized through a grant on a camelCase entity now records that grant and emits. Before, the event failed its own envelope parse and the operation failed. The envelope schema only widens: every value it accepted before still parses.

`ctx.link`, `ctx.grant`, `ctx.capabilities.mint`, `HostAdmin.grant` and `HostAdmin.grantToOrg` narrowed onto an entity, and `grantEntityLocal` now refuse a malformed entity ref when it is written, with `validation_failed` (error name `Substrat.validation_failed`, HTTP 400). A ref is malformed when its `entityType` is empty or has anything other than letters, digits, `_` and `-` (a colon, whitespace, a dot, non-ASCII), or its `entityId` is empty or has whitespace. An `entityType` that is one of the kernel's namespaces (`principal`, `org`, `tenant`, `scope`, `role`, `connection`, `capability`, `system`, `vertical`) is refused too, in any case; a type that only contains one, such as `scopeItem`, is fine. `ctx.revoke` does not check the grammar, so a grant stored earlier can still be removed. Refs already stored are not rewritten, and every stored ref the walk could read before still reads the same way. New export: `entityObjectRef` from `@substrat-run/contracts`.
