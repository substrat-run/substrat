---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/vertical-auth': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
---

An installed vertical's members can be managed from the dashboard (#1150): listed, invited, moved between roles and removed. Every change is bounded by what the signed-in person holds in the vertical's own scope (§5.1, K-21), asked in the scope task that writes it.

- Three scope-host verbs on both adapters, held by the permission contract suite: `listScopeRoleHolders(tenant, scope)` returns the live scope-level role assignments. `changeScopeRoleBounded(tenant, scope, caller, principal, from, to)` checks the caller's bound over both roles, then tombstones `from` and grants `to` in one transaction, or writes nothing. `revokeScopeRolesBounded(tenant, scope, caller, principal)` takes every scope role the principal holds, bounded over each, in one transaction. A role the tenant no longer defines confers nothing and is taken without a bound.
- vertical-host's `mountPlatformSurface` takes an optional `members` hook and serves `GET /internal/members`, `POST /internal/members/invite`, `…/role` and `…/remove`. Without the hook all four answer `501`. The owner of record answers `409` (move it with the owner hand-over), and so does a principal holding a role outside the hook's `roles`, and a role move for someone whose invite is still open (withdraw it and invite again at the new role). A removal withdraws the open invite first, then takes every scope role, then unbinds every login, so an accept of the old link afterwards finds nothing.
- vertical-auth's `membersHook({ roles, directory })` builds that hook. `mintMemberInvite` is now the one copy of what an invite is, run by both `mountInviteRoutes` and the platform route. The invite table's rows are plain functions in `@substrat-run/vertical-auth/member-directory`, which the IdentityDO delegates to, and `IdentityDO.listMemberBindings(scope)` gives the identity half of the roster.
- control-plane-api serves `/tenants/:t/scopes/:s/members` (`GET` and `POST`), `…/members/:principal/role` and `…/members/:principal/remove`, pinned to the tenant. A change is made as the person the tenant credential was minted for (`onBehalfOf`). A credential naming nobody is refused `403`. Each change leaves `manageScopeMember` admin rows, the intent and then the outcome (`HostAdmin.recordMemberChange`).
