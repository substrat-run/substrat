---
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/contract-tests': minor
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
---

Role assignment is now bounded by the assigner's own authority (K-21, membership.md §5.1). A principal may assign role `R` at node `N` only if they already hold every permission `R` carries at `N` — the rule that makes "assignment invents no authority" true rather than merely plausible. Without it the checkpoint that reviews role *definitions* protected nothing: an `admin` assigning themselves `owner` widens no role, calls no `defineRole`, and appears in no permission diff.

Module code asks `ctx.canAssign(roleKey)`, which answers `{ covered, missing }` — the missing keys, because that is the refusal a person can act on. It is a bound and not a permission check: the operation still opens with its own `assertAllowed(await ctx.check(…))`, which answers *may you manage members at all* where this answers *may you confer this much*. Removal takes the same bound, since a junior admin who can strip a role they could not have granted can lock an owner out of their own tenant.

Underneath, `PermissionChecker` gains `covers(subject, required, node)` — one resolution of the subject's effective set compared against the role, rather than N walks of the same tuples for an N-permission role. It is narrowing-aware, which is the load-bearing part: only authority held at the node counts, so an entity-narrowed grant does not satisfy the bound for the unnarrowed permission — otherwise sharing one record would launder into authority over every record by way of assignment. Membership still expands, because authority held through an org is authority that can be conferred. Both adapters implement it and a contract suite holds them to the same eight answers.
