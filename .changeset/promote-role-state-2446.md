---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': patch
---

A prod promote is refused when the release's roles would hold a scope's reconcile (#2446).

- **The promote asks the scopes it moves.** When a pushed vertical's release declares a system-held role, `POST /verticals/:slug/channels/prod/promote` reads, before anything moves, the roles each scope the promote would move onto it stores and the role keys seated there: every live (`active`, `suspended`) primary scope already on the serving script, and a private vertical's owned installs the adopt moves. It judges the release's role set with the reconcile's own rule (`reservedRoleSetRefusal`, through the new `releaseRoleSetRefusal`) and the reservations the release's registry marks. A scope that would refuse it, a seated person's role made `holder: 'system'` among the cases, refuses the promote with a 409 (`roleRefusals`, narrowed to the caller's tenant), and nothing is served, adopted or moved. The digest and export-break acknowledgements do not pass it; only staff's `roleStateUnjudged` (below) skips the read.
- **Who is asked nothing.** A release with no system-held role and no role key its registry leaves undeclared (`releaseRolesAskScopes`), and an embedded vertical, whose roles are its host's and not defined by any reconcile of the registry.
- **Bounds.** One promote reads at most `roleStateScopeCap` scopes (default 500), eight at a time in (tenant, scope) order. A promote that would move more is refused with a 503 that names the two ways through, never judged in part: raise `roleStateScopeCap`, or, as staff, promote with the new `acknowledge.roleStateUnjudged` (contracts' `promotionAcknowledgement`), which skips the read and is recorded in the promote's audit row with the other acknowledgements. A confined caller sending it is refused (403).
- **Skew.** A deployment that predates the read answers 404 and is moved unjudged; the promote counts it in its answer (`roleStateUnread`) and logs `promote.role-state.predates`. Its reconcile still refuses a role set it cannot define. Any other failed read, the deployment's own 501 included, refuses the promote with nothing moved.
- **New surface.** vertical-host: `GET /internal/role-state?tenantId&scopeId`, behind the platform gate every `/internal` route has, read-only, answering the optional `VerticalScopeHost.roleStateLocal` (501 without it). It names role keys, permissions and holders, never a principal. adapter-cloudflare and adapter-sqlite: `roleStateLocal(tenantId, scopeId)`. kernel: `RoleState`, `registryReservations`, `releaseRoleSetRefusal`, `releaseRolesAskScopes`. control-plane-api: `VerticalClient.roleState` and the `roleStateScopeCap` option. contract-tests: `roleStateContractSuite`.
