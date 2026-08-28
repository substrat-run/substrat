---
'create-substrat': patch
---

The scaffold's `AGENTS.md` names `ctx.grant` / `ctx.revoke` as how an app shares a record

An agent building a shared-list app found `CapabilityGrant` (the general capability-grant
type in `@substrat-run/contracts` — a principal, a permission, a node, an optional entity),
saw no revoke on it, checked that `ctx.link` edges cannot be removed, and concluded the
only revocable per-entity primitive was org membership — so it minted two orgs per list
and a tombstoned membership table, all in an append-only migration (#798). The primitive
it wanted was one file away on `OperationContext`, and nothing an agent reads had ever
named it.

`AGENTS.md` (and its published twin, `/guide/agent-rules`) now has a section that shows
the two-line shape — `ctx.grant(principal, perm, entityRef)` and
`ctx.revoke(principal, perm, entityRef)` — with the three guardrails (entity-required,
delegating, transactional), and says in the same breath why neither alternative is it: a
`ctx.link` edge is permanent, and org membership is revocable but coarse-grained. The
template playbook's kernel tier and seed step point at the same call and at the todo demo,
so a scaffolded project cannot rediscover the wrong answer from either document.
