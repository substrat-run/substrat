---
'@substrat-run/engine-test-kit': minor
---

`mintPrincipal()` and `grantOn()` — a harness that can build a principal whose
only authority is a grant on one row.

`as(permissions)` mints a principal and returns only a stub. That answers "may
someone holding these keys do this" and cannot answer "may someone holding this
key ON THIS ENTITY do this", because an entity-narrowed grant has to name the
principal it is for. So an engine could not be tested against the checks it
declares — the probe the entity-check conformance kit needs was unbuildable.

```ts
const probe = await h.mintPrincipal();          // no role, no tuples
await h.grantOn(probe.principal, PERM.sign, { entityType: 'protocol', entityId: id });
```

The grant goes through `host.admin`, so it resolves the way a production grant
does: along declared parent edges, refusing at the node. `as()` is now a one-line
wrapper over `mintPrincipal`, unchanged in behaviour.

engine-protocol drives its eight entity checks with this, and engine-workorder
the one it declares.
