---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/contract-tests': minor
---

A key added to a declared entity-grant shape now reaches the people who already held the shape (#2071). Before this, a release that added a key to a shape such as a person's grants on their own record only reached people linked after the deploy, while `PERMISSIONS.md` listed the key as held.

- Declare the shape `bootstrap: true` in `ENTITY_GRANTS` (`definePermissions({ entityGrants })`). Only a bootstrap shape is reconciled. A shape without the flag is a sharing shape, reached through `ctx.grant`, and is never reconciled or backfilled, so you can pass the whole `ENTITY_GRANTS` safely. The flag appears in the pushed permission registry, so it moves that vertical's permission digest once, and `PERMISSIONS.md` §4 gains a column saying which shapes are topped up.
- Give the shape with `grantEntityShapeLocal(scopeId, principal, entity, permissions)` on a CP-less host, or `HostAdmin.grantEntityShape` on any host. You no longer grant its keys one at a time. It writes every key plus a marker that records the person as a holder of the shape on that entity.
- Pass `ENTITY_GRANTS` to `mountPlatformSurface` as `entityGrants`, or to `provisionScopeLocal`. Every provision, `/internal/reconcile` and listed promote then gives each holder the keys the shape gained. `HostAdmin.reconcileEntityGrantShapes` runs the same reconcile on demand. It works in passes of 500 holders per scope transaction, so a large scope is never held in one long transaction.
- A key revoked from that person on that entity is never granted back, and a key dropped from the shape is never removed. Someone who was `ctx.grant`ed one key of the shape is not a holder and is not topped up.
- People granted before markers existed are found by provenance, never by which keys they hold. Declare `holder` on the shape: `'self'` when the entity id is the principal id, or `{ table, idColumn, principalColumn }` when your own table names the record's principal. The reconcile then marks each person on their own record when they hold a key of the shape there. A grant delegated on someone else's record is never marked. A bootstrap shape without `holder` gets no backfill: only people given it with the shape grant from then on are holders. The backfill runs in the same bounded passes as the top-up.
- `batch` must be an integer from 1 to 5000. Anything else is refused with `validation_failed`.
- Each person topped up is an `entity.grants-topped-up` event on the entity: `{ entity, principal, added }`, written by `@substrat-run/kernel`, with no operation and no authorization. The admin log records `grantEntityShape`, and `reconcileEntityGrantShapes` when a reconcile changed anything.
- **`ctx.revoke` now tombstones instead of deleting** (K-21). The row stays with `revoked_at` set, the checker skips it, and it stays readable as evidence. `ctx.grant` over a tombstone grants again. A module that counted `_substrat_tuples` rows to answer "is this shared" must add `revoked_at IS NULL`. A scope's dump keeps revoked grants, so it grows by one row per revoke.
