---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': patch
'@substrat-run/contract-tests': minor
'@substrat-run/cli': minor
---

A key dropped from a declared entity-grant shape can now be taken back from the people who already hold it (#2082). Until now the reconcile only added keys: a key removed from a bootstrap shape stayed with every existing holder, while `PERMISSIONS.md` showed the shape without it.

- To take a key back, list it in the shape's `retired` in `ENTITY_GRANTS`, for example `{ entityType: 'employee', permissions: [...], bootstrap: true, retired: ['expense:submit'] }`. At the next reconcile, every person holding the shape on an entity of that type has that key's row there tombstoned (K-21, never deleted). It runs once per scope, in the reconcile's existing bounded passes and transactions, and each person it touches gets one kernel-authored `entity.grants-retired` event on the entity: `{ entity, principal, removed }`. `HostAdmin.reconcileEntityGrantShapes` now returns `{ toppedUp, retired }`.
- **One tuple is one authority.** A direct `ctx.grant` of the same key to the same person on the same entity is the same row, so it is taken back too. The key held any other way stays: through a role, a grant on a parent, a grant on another entity, or by someone who is not a holder of the shape.
- **Putting a key back reaches only new holders.** After a retirement, a key returned to `permissions` reaches only people given the shape from then on. The top-up never grants a tombstoned key again, and a retirement leaves a tombstone. Returning the key does end that retirement, so a later release can retire it again.
- `retired` is allowed only on a bootstrap shape, never for a key the shape still grants, and never twice. Both `definePermissions`' registry and the push refuse anything else. It appears in the pushed permission registry, so declaring it moves that vertical's permission digest and needs a promote acknowledgement. A vertical that retires nothing keeps its digest.
- The promote diff (dashboard, console and `substrat promote`) shows each retired key as "existing holders lose K, including any direct grant of K on the same entity". It shows a key dropped without retiring it as "existing holders keep K". `PERMISSIONS.md` §4 gains a column for retired keys, only in a vertical that declares one.
