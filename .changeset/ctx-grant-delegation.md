---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

`ctx.grant` / `ctx.revoke` — an operation may narrow a permission it holds onto
one entity.

Every entity-narrowed grant in the fleet is made at seed time by
`HostAdmin.grant`, a platform actor's verb. So an app where a *person* shares
their own record with someone had no supported mechanism: `OperationContext`
offered `check`, `link` and `emit`, and nothing that could widen access at
runtime. The only way to ship such a feature was a membership table consulted by
hand in every handler — the forgotten-WHERE-clause failure this platform exists
to remove, reintroduced one vertical at a time.

Found by building a vertical forward from its model rather than converting one
that already existed: the todo demo's sharing feature is unbuildable without it,
and no existing demo could reveal the gap because all of their entity-narrowed
access is seeded.

Non-escalating by construction:

- **Entity-narrowed only.** `entity` is required, so module code can never write
  a scope-wide or tenant-wide grant.
- **Delegation, never elevation.** The caller's own decision on that entity is
  re-checked inside the verb, so an operation can only hand out what it was
  itself given.

Transactional with the operation, like rows and events: a grant made by an
operation that then throws never happened.

Pinned by five contract-suite cases both adapters run — the happy path, that the
grant reaches that entity and nothing else, the refused elevation, a control
proving a permission the caller *does* hold still grants, and revoke. The
refusal case is mutation-checked: removing the guard fails it.
