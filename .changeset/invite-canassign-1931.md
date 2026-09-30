---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/vertical-auth': minor
---

The member invite routes now apply the role-assignment bound (#1931). An admin can create an invite only at a role whose permissions they already hold at the scope, and revoke one only on the same terms, judged by the role the stored invite confers. A refusal is a 403 naming the missing permissions, and nothing is granted, recorded or removed. The admin gate still runs first, before the body is read, so a caller it refuses gets the same answer as before whatever they sent.

This needs three changes from a vertical that mounts `mountInviteRoutes`. Its `requireAdmin` returns the `{ principal }` it admitted. It passes `canAssign` for revoke and `assignScopeRoleBounded` for create, both wired to the host with the request's tenant and scope. A mount missing either dep, or with a gate that names no caller, refuses both routes instead of running them unbounded.

The host read, `host.canAssign(tenantId, scopeId, principal, roleKey)`, gives the answer `ctx.canAssign` gives that principal inside an operation, from the same projected role and the same comparison, so an entity-narrowed grant does not satisfy it. The new `host.assignScopeRoleBounded(tenantId, scopeId, caller, assignee, roleKey)` checks that bound and writes the scope grant in one serialized scope task. A refusal returns the missing permissions and writes no role tuple. Both adapters implement these methods, and the permission contract suite checks their answers and grant effects. The identity directory gains `getInvite`, which reads one open invite by its principal.

An invite whose role the tenant no longer defines can still be revoked. That role confers nothing, and the route lets through exactly the host's "no such role" refusal for that role; any other error still refuses. The kernel exports that refusal as `unknownRoleError` / `isUnknownRoleError`. On a host without a control plane, `host.canAssign` checks the scope was provisioned for the tenant it is asked under, and refuses as an unknown scope otherwise.

`ScopeHost.canAssign` and `ScopeHost.assignScopeRoleBounded` are new required members of the `ScopeHost` interface, so a host implemented outside these two adapters must add them.
