---
status: proposed
layer: plan
description: Inventory of what the dashboard's own ControlPlaneDO holds, and the phased plan with rollback for moving it to the shared directory (#1343). Nothing here has been run.
---

# Retiring the dashboard's own control-plane directory

Decision record for [#1343]. This is a source-code inventory and a migration plan, **not evidence that either live directory has been reconciled**. No live data has been read or changed for it. The dashboard's own `ControlPlaneDO` remains bound in both dashboard environments (`apps/dashboard/wrangler.jsonc`); `hostFor` still passes it to `CloudflareScopeHost` (`apps/dashboard/src/worker.ts`). The shared directory is a different DO, reached through `CONTROL_PLANE_SVC`.

The first revision of this brief listed three options. This revision picks one, records two facts the first did not state, and turns the chosen option into phases, each with the human steps, the checks and the rollback that belong to it. The decisions still open are in the last section.

## What is in each store

The table names and keys below are from `DIRECTORY_DDL` in `packages/adapter-cloudflare/src/control-plane-do.ts`. “Local” means the dashboard deployment's `CONTROL_PLANE` binding, not its `ScopeDO`. “Shared” means the control-plane deployment's directory. A code path proves that a row *can* be present; only the read-only inventory (phase 0) establishes which rows are present.

| Local table and key | Dashboard use | Shared directory today |
|---|---|---|
| `tenants` (`tenant_id`) | `provisionDashboard` creates the team; team deletion changes its `status`; login reads its name, slug and status. | The mirror ensures a tenant and updates its display name, but does not copy `status` or later lifecycle changes, so a deleted team stays `active` there. App provisioning also ensures a tenant independently. |
| `scopes` (`scope_id`) | `provisionDashboard` creates and activates the team's **dashboard** scope. `host.getScope` validates tenant, scope and lifecycle against this row before authenticated operations. | App scopes are created through the shared service. The dashboard scope is not mirrored. |
| `_substrat_identity_pools` (`provider`) and `_substrat_identities` (`tenant_id`, `provider`, `external_id`) | `ensureIdentityPool`, team creation and invite acceptance write links; login and team switching read cross-tenant memberships; leave, member removal and team deletion unlink. The identity row also carries principal and optional landing scope. | The mirror ensures the pool and copies an active tenant's current login link, including principal and optional scope, on team creation, invite acceptance and `/api/me`. Shared unlink is best effort, and before phase 0 its failure on member removal and leave left no log line. There is no general cross-tenant dashboard login read on the service seam. |
| `_substrat_roles` (`tenant_id`, `role_key`) | `provisionDashboard` writes the declared team roles; `reconcileRoles` updates definitions on a login's first resolve in an isolate. | No role-definition mirror or service write. The service-only assignment routes from #1370 do not create definitions, so an assignment alone grants nothing. |
| `_substrat_tenant_tuples` (`tenant_id`, `subject`, `relation`, `object`) | Owner assignment and the membership executor's tenant-level add/remove write role tuples; revocations are tombstones. | No mirror. Scope-local projection can copy these rows into a `ScopeDO`, but that is not a copy into the shared directory. |
| `_substrat_entitlements` (`tenant_id`, `entitlement_key`) | Team bootstrap grants the dashboard and invites entitlements; legacy roster healing can grant invites. | No mirror of these local grants. App entitlements in the shared directory are separate writes. |
| `orgs` (`org_id`) | Team creation makes the `team` org; legacy roster healing may do the same. | No mirror. The dashboard roster itself is in `ScopeDO`; the org is a directory row. |
| `verticals` (`slug`) | `ensureCatalog` registers current builtins and marks older local entries unlisted or blocked. Dashboard reads merge this local catalog with the shared catalog. | The shared catalog has its own entries; the two sets are not interchangeable. `vertical_versions` (`id`) and `vertical_channels` (`vertical_slug`, `channel`) may also contain historical embedded-mode rows; current connected app deployment writes go to the shared plane. |
| `_substrat_connections` (`id`) and `_substrat_connection_secrets` (`connection_id`) | The GitHub callback creates/replaces a local connection; repository reads open its sealed installation reference. Revocation leaves historical metadata. | These connections are **not mirrored**. The shared plane's app connections are distinct. Phase 4 moves them, sealed values copied sealed (Decisions). |
| `hostnames`, `scope_*`, `tenant_stores`, `blob_stores`, `lifecycle_*` | Written only by the embedded-mode arms in `provision.ts`, which a deployment no longer reaches: `controlPlaneFor` refuses without the service binding (#978). | Not mirrored. Any rows are historical. |
| `_substrat_admin_log` (`id`) and `_substrat_access_log` (`id`) | Local administrative writes and audited directory reads append history. | No mirror. These records describe the local directory's actions; copying them into the shared log would misstate their origin. Exported privately and kept 90 days (Decisions). |

`dashboard_apps`, `dashboard_members`, `dashboard_team`, `dashboard_app_events`, `dashboard_app_env`, `dashboard_install_steps` and `dashboard_connect_links` live in the dashboard **ScopeDO**, and nothing here moves them. `GithubRepoLinkDO` and `SweeperDO` are separate bindings, also untouched. Phase 0 counts every local directory table, including tables without an identified current writer, before any is treated as empty.

## Divergence and dependencies

The mirror in `src/identity-mirror.ts` writes tenant, display name and one identity link only. It logs failure and returns without failing the local request. A failed create/link leaves a local-only link until that user returns to `/api/me` or another mirror call. A failed shared unlink leaves a shared-only link. A shared-side change can also leave a different principal for the same `(provider, externalId)`; a count comparison misses that. `/api/teams/:teamId/identity-mirror` and `deriveIdentityDivergence` (#1366) expose missing, extra and conflicting links **for the caller's tenant**; phase 0 adds the fleet-wide count. The next mirror attempt may overwrite a shared-side difference, so every conflict needs review before any automated repair.

The local DO has three independent jobs today:

1. **Login and tenant selection.** `account.ts` uses `listIdentityMemberships` to answer which teams a login belongs to, then resolves the selected team. `listIdentityTenants` and `resolveIdentity` are used elsewhere in `worker.ts`. The existing `TenantNarrowedControlPlane` cannot answer the first, cross-tenant question because it requires a tenant at construction.
2. **Scope admission and administration.** `host.getScope` calls directory-backed `validateScopeAccess`; `provisionDashboard`, team lifecycle, role reconciliation, membership effects, org creation, catalog reads and GitHub connection operations use `host.admin`. Merely dropping `CONTROL_PLANE` makes these calls unavailable. A CP-less host's no-op directory gate assumes an upstream router checks lifecycle; the dashboard is reached directly, so that assumption needs an explicit replacement.
3. **Permission inputs.** With `SCOPE_LOCAL_PERMISSIONS` off, the checker reads role definitions and tenant tuples from the local directory. The flag is on in the test environment and absent in the production config. With it on, writes and `reconcileTenantProjection` project roles, tuples, entitlements and identity links into each scope; the checker can then read locally. This covers the permission path, **not** cross-tenant login, directory administration or `validateScopeAccess` (`docs/architecture/scope-local-permissions.md` §9 question 4).

### Two facts that constrain every shape

**Projection fan-out addresses every scope the directory lists, through the host's own scope namespace.** `fanOut` in `packages/adapter-cloudflare/src/host.ts` lists the tenant's scopes from the directory and sends the projection to each through `this.scopeStub(id)`. Today the local directory lists only the team's dashboard scope, so that is right. Put the dashboard's host over a directory that also lists the tenant's **app** scopes and a membership change would address a `ScopeDO` in the dashboard's namespace under an app's scope id, creating a Durable Object nothing serves. The same holds in reverse for the control plane's host meeting a dashboard scope row. Every shared-plane enumerator of `scopes` (sweeps, drains, reaping, console lists, tenant deletion) would also meet a dashboard scope that no dispatched script serves. Phase 2 exists for this.

**The scope-local switch is one-way per scope.** A scope that has received a projection reads its permissions from its own storage and has no path back. Turning `SCOPE_LOCAL_PERMISSIONS` off after scopes have switched stops the fan-out while those scopes keep reading their projection, so a later revocation would not reach them. Turning the flag off is therefore **not** a rollback for phase 1. Re-running `reconcileTenantProjection` is.

## Target shape

The shared directory becomes the dashboard's only directory. Permissions are evaluated scope-locally (`scopeLocalPermissions` on), so no `ctx.check` reads the shared singleton per request. The remaining reads — which teams a login belongs to, scope admission, administration — go to the shared directory over a privileged path that only the platform's own dashboard holds, and builder-facing routes stay tenant-narrowed. The builtin catalog stops being written into a directory at all: it is already a deploy constant (`CATALOG`), merged at read.

The privileged path is a **direct Durable Object binding** from the dashboard to the control plane's directory class. It needs no new HTTP routes and keeps the control-plane API's existing policy that identity resolution is not an HTTP route. Service-only HTTP routes on the control plane (a cross-tenant login read, role-definition writes) were the alternative and are not pursued.

## Phases

The invariant every phase holds: **a login that resolves today resolves to the same principal the moment after, and no phase depends on a user returning to `/api/me`.** The local directory stays authoritative until phase 6. From phase 6 until 7a the shared directory decides, with a fallback to local whenever the shared side has no membership for a login the local side does. 7a requires an observation window with no fallback at all.

Each phase is its own PR and its own checkpoint, and none starts before the previous phase's exit check is met. "Paste back" means the operator posts the named output on the tracking issue's private channel, not in a public comment.

### Phase 0 — inventory, and an honest unlink

Code: a read-only inventory route on the dashboard, `GET /api/internal/directory-inventory`, gated on a credential set for it alone per environment, and a 404 while that credential is unset. It answers counts only: every local directory table with its row count, local teams by status, and, a page of teams at a time, the identity comparison with the shared directory summed over the page (local, shared, missing, extra, conflicting, teams that diverge, teams whose shared side could not be read). No team, person, login or id is in the answer. Member removal and leave stop swallowing a failed shared unlink; it is logged as `dashboard.identity-unmirror.failed`, the same way a failed link is.

Steps: run the inventory in the test environment, then production, walking every page. Paste back the `local` block and the summed `identities` totals.

Exit check: every table with rows has a phase below that owns it, or the explicit decision to discard it. Rollback: none needed; the route reads only and the logging changes no outcome.

### Phase 1 — scope-local permissions in production

Code: the production flag, and a staff-run reconcile that walks every active dashboard team and runs `reconcileTenantProjection` on it, reporting how many teams converged and which did not. A dashboard team's directory holds one dashboard scope, so the fan-out is one scope per team (`scope-local-permissions.md` §9 question 1); phase 0's counts confirm it.

Steps: in the test environment, where the flag is already on, run the reconcile and paste back its summary. Walk the permission matrix by hand: owner, invited member after accepting, removed member (denied on the next request), a member who left, a deleted team, an entitlement-gated action. Paste pass or fail per row. Then the same in production, on a team staff own.

Exit check: every active dashboard scope reads locally, the matrix passes, and no projection failure is logged for **7 days**. Rollback: re-run the reconcile; a misbehaving scope is repaired by reconciling its tenant, and a wrong projection is fixed in code and then reconciled. Not the flag.

### Phase 2 — guards before any shared write

Code only, no data: fan-out and projection address only scopes of the verticals the host serves; every shared-plane `scopes` enumerator skips the dashboard's own scopes (a backstop: no dashboard scope row is ever written there); `ensureCatalog` writes nothing to a directory. Tests cover each (see below). Rollback: revert the PR.

### Phase 3 — shadow read

Code: every login membership read, team switch, scope admission and role read also reads the shared directory in the background, compares, and logs one line `dashboard.directory-shadow` with the kind of read and the outcome (`same`, `missing`, `extra`, `conflicting`), never a login or principal. Local still decides. Sampled conservatively, because the shared directory is one Durable Object with a history of running out of memory: every team switch and scope admission on a write, and **one login read in twenty**, with the rate a deployment variable so it can be lowered without a release.

Steps: in the test environment, after 24 hours, group the shadow lines by kind and outcome and paste the table, with the shared directory object's CPU and memory over the same window. Production after 72 hours, the same.

Rollback: switch the shadow read off. Nothing reads its result.

### Phase 4 — continuous copy, local to shared

Code: an idempotent per-team copy, keyed on the local ids, through the privileged path: the tenant with its status (the dashboard scope row is **not** copied; see Decisions), the identity pool and links, role definitions, tuples (a revocation is copied as a revocation and never resurrects a grant), entitlements, orgs, and the GitHub connections (below). It runs after every local tenant-level write, at the same hook as the fan-out, and as a paged staff sweep. It replaces the `/api/me` mirror. A row only the shared side holds is **reported, never deleted**: the builder plane writes some of them. A conflict is reported, never overwritten.

Steps: run the sweep in the test environment and paste the phase-0 inventory totals; then production.

Exit check: two consecutive daily inventories with nothing missing, nothing conflicting, and every extra row explained by the shared-side writer that made it. Rollback: stop the copy. What it wrote is additive and nothing decides on it yet.

### Phase 5 — resolve conflicts

A person reviews every conflicting identity link. The truth is the principal on the team's roster row in its dashboard scope; the wrong side is corrected by a staff unlink and relink. Then a final sweep and inventory. Paste back the totals: zero missing, zero conflicting. No writer hold is planned: phase 4's per-write copy keeps the difference at zero, and a short hold of directory writers is the fallback if the inventory will not stay there.

### Phase 6 — cut over, with a fallback and a reverse copy

Code: a deployment variable selects the shared directory for the dashboard's host. Login reads shared; **when shared has no active membership for a login and local does, the local answer is used and `dashboard.directory-fallback` is logged.** That is what keeps every signed-in user resolving. Scope admission reads the shared tenant status and the scope's own receipt, the status cached 60 seconds (Decisions). Writes go to the shared directory, and the phase-4 copy runs in reverse, shared to local, so the local directory stays a valid rollback target.

Steps: in the test environment, sign in as an existing member, switch team, create a team, invite and accept, remove a member, leave, delete a team, list GitHub repositories, create and update an app; paste pass or fail per step. The same in production on a team staff own. Daily, paste the fallback count and the inventory in both directions.

Exit check: **14 days** with no fallback and no difference in either direction; any fallback restarts the count. Rollback: set the variable back to local. Run the inventory in the local direction first to confirm the reverse copy holds every write made since the cutover.

### Phase 7a — remove the binding, keep the data

Code: remove the fallback, the reverse copy, the mirror (`identity-mirror.ts`'s write half, the `/api/me` background call, the per-team mirror route), the embedded-mode arms, and the dashboard's `CONTROL_PLANE` binding. **Keep the `ControlPlaneDO` export and change no migration**, so the local data is retained and reachable again by restoring the binding. Rollback: restore the binding and the variable; first reverse-copy any write made since 7a, from code still in history.

### Phase 7b — delete the class

Only after: 7a has run **at least 30 days** with no rollback; a final export of the local directory has been taken and verified readable, and kept privately under the retention decision (below), never in the repository or a public artifact; and GitHub connections have been moved, or reconnected where a row could not move. Then a new migration tag, in **both** environments' migration lists:

```jsonc
{ "tag": "v4", "deleted_classes": ["ControlPlaneDO"] }
```

and the export goes. This deletes every row in the **dashboard's** namespace of that class and nothing else: the control plane's class of the same name belongs to a different script. The test environment proves it first, with the shared-side inventory counts unchanged across the deploy. This step cannot be undone. The original v1 tag stays in history.

### A link that fails to reach the shared directory during the move

Before phase 6 the person is unaffected, because local decides. The failure is logged, the per-write copy and the daily sweep retry it without waiting for them to sign in again, the inventory counts it as missing, and phases 5 and 6 do not start while any is missing. Between phase 6 and 7a, the fallback resolves the person from local, logs it and restarts the 14-day count while the copy retries. A conflicting link (one login, two principals) is never repaired automatically in either direction; it blocks the cutover until a person resolves it against the roster. After 7a there is no local copy, which is why 7a needs a window with no fallback.

### Historical embedded-mode rows

Rows in `hostnames`, `vertical_versions`, `vertical_channels` and the other embedded-mode tables are **discarded**: phase 0 counts them, nothing copies them, and they go with the class in 7b. This was decided with this revision.

## Tests

- One table-driven test of the divergence derivation over every directory fact: missing, extra, conflicting, a tombstone not resurrected, a tenant status that differs.
- The copy against two real directories (`SqliteScopeHost`): after a copy the two agree; a second copy writes nothing; a conflicting link is reported and left alone.
- The fallback: the shared side lacks a link the local side has, and the login resolves to the same principal and writes one fallback line.
- The fan-out guard, on workerd: a directory listing a team's dashboard scope and an app scope; a membership change projects into the dashboard scope only and creates no Durable Object under the app's id.
- `ensureCatalog` writes nothing to the directory.
- With 7b, a source assertion that the dashboard's configuration binds no local `ControlPlaneDO` and lists it in `deleted_classes` in both environments.

No test runs against a live environment; the test environment is driven by the steps above.

## Checkpoints

| Phase | Checkpoint |
|---|---|
| 0 | Staff route and its answer's shape |
| 1 | Permission: changes how production answers `ctx.check`, one way per scope |
| 2 | Adapter contract: which scopes a fan-out and the shared enumerators reach |
| 3 | Privileged path from the dashboard to the shared directory |
| 4, 5 | Migration: dashboard state written into the shared directory |
| 6 | Migration: authority moves |
| 7a | Migration: the rollback target's binding is removed |
| 7b | Migration, destructive: `deleted_classes` |

## Decisions

Settled with this revision:

- The plan is the staged dual-read and cutover (the first revision's option A), with the phases above. The one-shot copy (option B) and keeping login local (option C) are not pursued.
- Historical embedded-mode rows are discarded (above).
- The observation windows are 7 days (phase 1), 14 days with no fallback (phase 6) and at least 30 days (7a to 7b).
- Shadow reads are sampled as phase 3 states.
- The privileged path is a direct Durable Object binding (Target shape).
- **GitHub connections are moved** into the shared directory's connection model, not kept in a second store and not reconnected by default: a second store would keep the split alive, and reconnecting makes every team redo an integration that works. A sealed value is copied **sealed**, never opened or logged on the way. Phase 4's design first establishes what a connection row actually holds and which parts are secret; a row that cannot be moved safely is named there, and only that case is reconnected.
- **The local admin and access logs** are exported privately, before 7b, to a staff-only storage location; the export is kept 90 days and then deleted. The rows themselves go with the class in 7b.
- **The dashboard scope has no row in the shared `scopes` table** (`scope-local-permissions.md` §9 question 4). It is admitted on the team's tenant status in the shared directory plus the scope's own `provisioned_for` receipt, which names its tenant and refuses any other. A team has exactly one dashboard scope, created and removed with it, so the tenant's status carries its whole lifecycle. With no row, no shared enumerator ever meets a scope that no dispatched script serves, and phase 2's enumerator guard is a backstop rather than a rule every future enumerator must remember. Nothing in front of the dashboard checks lifecycle, so the dashboard reads the tenant's status itself, once per sign-in and team switch, cached for **60 seconds**: suspending or deleting a team takes effect within that window, not on the very next request. Staff tools that need the dashboard scopes derive them from the team list, one per team.

No question is open.

[#1343]: https://github.com/substrat-run/substrat/issues/1343
