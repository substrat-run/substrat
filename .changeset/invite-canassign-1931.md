---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/vertical-auth': minor
---

The member invite routes now apply the role-assignment bound (#1931). An admin can create an invite only at a role whose permissions they already hold at the scope, and revoke one only on the same terms, judged by the role the stored invite confers. A refusal is a 403 naming the missing permissions, and nothing is granted, recorded or removed. The admin gate still runs first, before the body is read, so a caller it refuses gets the same answer as before whatever they sent.

This needs two changes from a vertical that mounts `mountInviteRoutes`. Its `requireAdmin` returns the `{ principal }` it admitted, and it passes a `canAssign` dep, one line over the host: `canAssign: (env, node, principal, roleKey) => hostFor(env).canAssign(node.tenantId, node.scopeId, principal, roleKey)`. A mount without the dep, or with a gate that names no caller, refuses both routes instead of running them unbounded.

That line uses a new host read, `host.canAssign(tenantId, scopeId, principal, roleKey)`. It gives the answer `ctx.canAssign` gives that principal inside an operation, from the same projected role and the same comparison, so an entity-narrowed grant does not satisfy it. Both adapters implement it, and the permission contract suite holds the two answers equal. The identity directory gains `getInvite`, which reads one open invite by its principal.
