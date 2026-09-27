---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

An operation can now move an entity to a different parent: `ctx.relink(child, from, to)` (#1864). Access follows the move. A grant above the old parent stops reaching the entity, a grant above the new one starts, and no check in between sees the entity without a parent. Before, the only option was a second `ctx.link`, which added a parent. The grant above the old parent then kept reaching the entity after every move.

`ctx.relink` checks no permission, the same as `ctx.link`. The operation checks the child, `from` and `to` in its own vocabulary before calling it. The kernel refuses:

- a `to` whose relation is not declared in `entityRelations`, the rule `ctx.link` already applies (`validation_failed`)
- a `to` that is the child itself or lies beneath it, since the move would make the child its own ancestor (`validation_failed`)
- a malformed or reserved ref at any of the three ends (`validation_failed`)
- a `from` that is not a current parent of the child (`conflict`)
- any call from a read-only impersonation session

Moving to the parent the entity already has does nothing. An entity with several parents keeps the others. The old edge is marked revoked rather than deleted, but the lasting record of the move is the event: one `entity.relinked` event on the child (`{ child, from, to }`), stamped with the operation's actor, authorization and operation name. It is transactional with the operation, so a relink in an operation that throws never happened, and neither did its event. New exports: `ENTITY_RELINKED`, `entityRelinkedPayload`, `ENTITY_LINKED` and `entityLinkedPayload` from `@substrat-run/contracts`, and `createEntityEdgeVerbs` from `@substrat-run/kernel`.

**`ctx.link` changed in two ways.** Linking to a parent the entity was moved away from brings that edge back, and records it as one `entity.linked` event on the child (`{ child, parent }`), because access that had stopped resumes. Before, the link was silently ignored, so it granted nothing. A first-time link still emits nothing. An undeclared relation is now refused with `validation_failed` (HTTP 400) and a message starting `ctx.link: undeclared entity relation`, where before it was a plain error.

**`ctx.emit` refuses the event types the kernel writes itself**: `attachment.added`, `attachment.removed`, `capability.minted`, `capability.revoked`, `capability.exercised`, `entity.relinked` and `entity.linked`, with `validation_failed`. Before, an operation could emit any of them and forge a move, a share or an upload that never happened. The kernel still writes them. New exports: `KERNEL_AUTHORED_EVENT_TYPES` and `assertModuleEmittableType` from `@substrat-run/contracts`.
