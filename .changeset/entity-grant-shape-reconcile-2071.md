---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/contract-tests': minor
---

A key added to a declared entity-grant shape now reaches the people who already held the shape (#2071). Before this, a release that added a key to a shape such as a person's grants on their own record only reached people linked after the deploy, while `PERMISSIONS.md` listed the key as held.

- Give the shape with `grantEntityShapeLocal(scopeId, principal, entity, permissions)` on a CP-less host, or `HostAdmin.grantEntityShape` on any host. You no longer grant its keys one at a time. It writes every key plus a marker that records the person as a holder of the shape on that entity.
- Pass the same shapes to `mountPlatformSurface` as `entityGrants`, or to `provisionScopeLocal`. Every provision, `/internal/reconcile` and listed promote then gives each holder the keys the shape gained. `HostAdmin.reconcileEntityGrantShapes` runs the same reconcile on demand. It works in passes of 500 holders per scope transaction, so a large scope is never held in one long transaction.
- A key revoked from that person on that entity is never granted back, and a key dropped from the shape is never removed. Someone who was `ctx.grant`ed one key of the shape is not a holder and is not topped up. Pass only the shapes you give people on their own records. A sharing shape, which people reach through `ctx.grant`, must never be passed.
- People granted before markers existed become holders on the first reconcile if they hold every key of the shape as it is then. Ship the release that adopts this before the release that grows the shape.
- Each person topped up is an `entity.grants-topped-up` event on the entity: `{ entity, principal, added }`, written by `@substrat-run/kernel`, with no operation and no authorization. The admin log records `grantEntityShape`, and `reconcileEntityGrantShapes` when a reconcile changed anything.
- **`ctx.revoke` now tombstones instead of deleting** (K-21). The row stays with `revoked_at` set, the checker skips it, and it stays readable as evidence. `ctx.grant` over a tombstone grants again. A module that counted `_substrat_tuples` rows to answer "is this shared" must add `revoked_at IS NULL`. A scope's dump keeps revoked grants, so it grows by one row per revoke.
