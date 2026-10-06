---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

The trash is now held by the host, and a trashed entity can be purged after a declared horizon (#119).

- **The host refuses an operation on a trashed entity.** An operation whose check is `permission: { entity, idFrom }` over an entity that declares `trash` is refused on a trashed one before its guards and handler run. A caller holding the operation's key gets `not_found`. A caller without it gets the same `permission_denied` an active entity gives them, so the bin cannot be probed. Archived entities are never refused.
  - Opt in per operation with `trashed: 'admits'` (a restore, a read of the bin) or `trashed: 'purges'` (the entity's one permanent delete, whose input must be a strict object holding the id and nothing else). The compiler allows either only on an `idFrom` check over an entity that declares `trash`.
  - The host derives which entity each operation addresses from your declarations: `operationInputsOf(ops)` now records the declared surface of the map it returns. A module that declares a trashable entity must pass that map as returned (not a copy or a hand-built one), with every operation it binds declared, or it no longer registers. The map is frozen.
  - An operation whose check is `resolved` in the handler is not refused by the host; keep its `ctx.entityState` check. `trashRefusalGapsOf(ops, entities)` names them, and `lint:model` prints a warning for each.
- **`ctx.link` refuses a trashed parent**, and `ctx.relink` a trashed `to`, with `not_found` — the same refusal a missing parent of a trashable type now gets, so the two cannot be told apart. An archived parent is allowed, and a child can still be moved out from under a trashed `from`.
- **Purge horizon.** Declare `trash: { permission, purgeAfterDays }` and spread `schedules: purgeSchedulesOf(ops, entities)` into your manifest. Every hour, the platform runs your `trashed: 'purges'` operation as the module's system principal on each entity that has been in the trash longer than the horizon, one entity per transaction and up to 50 per pass.
  - Each purge re-checks inside its transaction that the entity is still due, so a restore always wins.
  - A failed purge leaves that entity in the trash for the next pass.
  - A preview or fork never purges, a suspended scope or tenant does not purge, and the kill switch (`revokeFromSystem`) stops purging on a scope. The scope re-checks the holds it records before and during each purge. On a directory-backed host that is the kill switch, and the platform's coordinator enforces the lifecycle, copy and tenant holds.
  - The system principal's purge key is refused to it on every other call.
  - The events about a purged entity stay. Registration refuses a horizon without its schedule, and a purge schedule that runs any other operation.
  - The kernel derives a partial index on `_substrat_trashed_at` for each entity with a horizon.
- Purge authority comes only from the platform's own sweep. The cutoff is computed by the host from its clock and the horizon, and an invoke that tries to supply one is refused `validation_failed`.
- `entityTrashContractSuite` holds both adapters to all of the above.
