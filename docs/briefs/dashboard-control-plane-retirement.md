---
status: proposed
layer: plan
description: Inventory of what the dashboard's own ControlPlaneDO holds, and a staged plan with rollback for moving it to the shared directory (#1343). Nothing here has been run.
---

# Retiring the dashboard's own control-plane directory

Inventory and migration plan for [#1343]. **Nothing here has been run.** The migration
checkpoint applies: this is the data move presented for review, and the production step
is deliberately left for a human.

## The framing needs correcting first

`docs/architecture/dashboard.md` §3 and #1343 both describe the deployment's own
`ControlPlaneDO` as holding **identity links**, mirrored best-effort into the shared
directory on every `/api/me` (#265). That is the part that has two sources of truth, and
it is the part that has been visible — but it is not what the DO holds.

`env.CONTROL_PLANE` is handed to `CloudflareScopeHost` as its `controlPlane`
(`apps/dashboard/src/worker.ts`, `hostFor`). The dashboard is itself a vertical (#1185)
running a scope per team, so that DO is **the whole directory backing the dashboard's own
host** — tenants, scopes, roles, grants, entitlements, its vertical catalog and its audit
log. Identity links are one table of the several in use.

This matters for the size of the move. Retiring the DO is not "copy the links across"; it
is "make the dashboard's host read a directory it does not own".

## What the local DO holds, confirmed from code

Every row below is written by a call the dashboard makes on `hostFor(env)`. The writer is
named so a reviewer can check the claim rather than take it.

| Table | Written by | Also in the shared directory? |
|---|---|---|
| `tenants` | `provisionDashboard` → `createTenant` (`src/provision.ts`) | **Yes** — the mirror calls `ensureTenant` and syncs the name (`src/identity-mirror.ts`) |
| `_substrat_identities`, `_substrat_identity_pools` | `linkIdentity` / `registerIdentityPool` | **Yes**, best-effort — the mirror's `linkIdentity` on every `/api/me` |
| `scopes` | `provisionScope` + `activateScope` for the team's DASHBOARD scope | **No** — the shared plane knows a team's *apps*, provisioned through `src/authority.ts`; the dashboard's own scope is not among them |
| `_substrat_entitlements` | `grantEntitlement` — the dashboard vertical, and `invites` | **No** |
| `_substrat_roles` | `defineRole` for each entry in `ROLES` | **No** |
| `_substrat_tenant_tuples` | `assignRole` — the owner seat, and every later grant | **No** |
| `verticals` | `ensureCatalog` seeds from `CATALOG`, and flags retirements (`src/catalog.ts`) — the only local writer | **Partly** — `oidcProviderSlugsFor` reads `local` AND `remote` and merges them, so the two catalogues are known to differ by construction. The rows that are *not* current `CATALOG` entries are the retired builtins (#389), kept `installsBlocked` and unlisted; see step 4 |
| `_substrat_admin_log`, `_substrat_access_log` | every audited admin call above | **No** — and see "What cannot move", below |

The remaining 18 tables in `ControlPlaneDO`'s DDL (connections, versions, channels,
hostnames, sweep runs, ops failures, model usage, …) are fleet concerns the dashboard
reaches through `controlPlaneFor(env, tenantId)` — the shared plane, over HTTP. They are
almost certainly empty in the dashboard's own DO. **Almost certainly is not confirmed**:
see the first verification step.

## What has to be checked against live data

Questions the code cannot answer, each of which changes the plan:

1. **Which tables actually have rows in production?** The table above says what the code
   *can* write, not what is there. A table that is empty needs no backfill, and one that
   is unexpectedly non-empty is a path nobody has accounted for.
2. **Do the mirrored facts actually agree?** The mirror is best-effort and one-directional
   — #1343's own words: "a link that fails to mirror is invisible until the next
   `/api/me`, and nothing reconciles a divergence in the other direction." So the number
   of identity links on each side, and whether they map to the same principals, is the
   thing that decides whether this is a backfill or a reconciliation.
3. **Does any team have a dashboard scope whose tenant the shared plane does not know?**
   The mirror runs on `/api/me`, so a team that provisioned and never signed in again
   would have been mirrored at sign-up; a team that predates #265 may not have been.
4. **Does anything still resolve through the retired builtin rows in `verticals`?** The
   `meridian` and `manyfold` builtin rows persist for their archived scopes (#389), and
   the backfill below does not carry them across. If an archived scope still reads its
   vertical's name or flags off that row, it needs to, and step 4 has to say how.

These are reads of production state. They are not run here.

## What cannot move — decided

The **admin and access logs** in the local DO are history. They can be copied, but a copy
is not the same artifact: the entries were written by a different directory about actions
taken against it, so the copy would be a log claiming to record events it was not present
for. Everything else in this migration is a fact that is still true (this team has this
scope, this role exists); a log entry is a claim about a past event in a particular place.

**Decided 2026-09-15: accept the loss.** They are the dashboard's own directory trail —
teams created, roles defined, scopes activated — plus the K-24 record of staff reads.
Nothing a customer sees and nothing another system reads. They are not carried across and
not archived, so the cutover is where the dashboard's own audit history begins.

The one thing worth re-reading before the DO is dropped: the access-log half is the "who
read this tenant's data" trail, and it becomes unrecoverable at step 7 rather than at the
cutover. If that answer changes, it has to change before then — which is why the sequence
below drops the class last.

## Where any of this runs — the constraint the sequence hangs off

`ControlPlaneDO` is bound in **two workers**: `apps/control-plane` holds the shared
directory (what the console reads, through the CP API), and `apps/dashboard` holds its own
instance — a different Durable Object namespace.

A DO is reachable only through a binding, so the rows to be migrated can be addressed by
**the dashboard worker and nothing else**. Not the console, not the CP API, not a script
with staff credentials. Every step below therefore executes inside that worker, which is
the fact that makes this a code change rather than an operator task.

That does **not** mean a staff surface in the dashboard's UI, and it should not become a
standing route: this is a one-off migration, and a permanent privileged endpoint outliving
a job that runs a handful of times is a worse trade than the migration itself. Whatever
entry point the inventory and backfill use is expected to be removed in the same series
that drops the binding — step 7 already deletes more than this.

## Proposed sequence

Each step is separately revertible, and nothing before step 5 changes what a signed-in
user resolves to.

1. **Inventory against production** (read-only). Answer the questions above. Output
   is a row count per table on both sides, and a diff of the identity links.
2. **Backfill the facts that are only local** — scopes, entitlements, roles, tuples —
   into the shared directory, for every team. Idempotent, so it can be re-run: every
   verb involved (`ensureTenant`, `provisionScope`, `grantEntitlement`, `defineRole`,
   `assignRole`) is already an upsert or is guarded by one at its call site. That only
   holds if every row **keeps its local identity**: the adapters key a tenant by its
   `tenantId`, a scope by its `scopeId`, and a role, entitlement or tuple by the key the
   caller supplies, so the backfill carries those across unchanged and mints nothing. A
   fresh id would slip past the existing-row check and then fail on slug uniqueness (or,
   for a tuple, quietly become a second logical grant). If a collision on the shared side
   ever forces a remap, the mapping is persisted and reused for every dependent row and
   every retry — never recomputed.
3. **Reconcile identity links in both directions**, and fail loudly on a conflict — the
   same external id mapping to different principals is the one case that must not be
   auto-resolved, because picking either answer signs somebody into the wrong team.
4. **Hold the local writers, then run the delta.** Between step 2 and the flip the
   dashboard has kept writing locally — `POST /api/teams` creates a tenant, scope, roles,
   entitlements, owner tuple and identity link through `hostFor`, `/api/invites/accept`
   adds a tuple, `/api/members/remove` and `/api/teams/leave` take one away — so a
   backfill that finished an hour ago is already behind, and the shared directory would
   be missing exactly the newest teams when the reads move. So the membership writers
   (team create, delete and leave; invite accept; member remove) are held — a `503` on
   those routes, nothing that reads — step 2 is run again with the hold on (idempotent,
   so what it writes *is* the delta), and the hold stays on through the next step.
5. **Flip the reads.** `hostFor` takes the shared directory. This is the step with a user
   -visible window, and the one to do with a rollback ready: reverting the binding
   restores the old directory, which the backfill left untouched. Two things change on
   the way past that the table above only implies. The identity reads that decide who a
   session is (`listIdentityTenants` in `/api/me`) now answer from the shared directory,
   which is what step 3 was for. And `ensureCatalog` now seeds `CATALOG` into the
   **shared** registry on its first read — a new write to the shared plane, so the shared
   registry is checked for the `protocol` and `callout` slugs beforehand. The retired
   builtin rows are deliberately not carried: a registry that never had a `meridian`
   builtin refuses the same install by absence that `installsBlocked` refused by flag,
   and question 4 above is what confirms nothing else reads them.
6. **Drop the mirror write** in `/api/me`, once nothing reads the local copy.
7. **Drop the binding, then the DO class,** and the `v1` migration entry stays — a
   `new_sqlite_classes` tag cannot be withdrawn, only superseded by a `deleted_classes`
   migration.

Steps 6 and 7 are the only irreversible ones, and both come after the flip has been
observed to hold.

## The rollback

Until step 7, the local DO still has every row it had: the backfill writes to the shared
directory and touches nothing locally. So the rollback for step 5 is to put the binding
back. That property is worth protecting deliberately — **the backfill must never delete
or rewrite local rows**, however tempting a "cleanup" looks while writing it, because it
is the entire reason this move has a way back.

It is a clean rollback only **until the first membership write after the flip**. Once
`hostFor` points at the shared directory, a team created there — the same `POST
/api/teams` — exists in the shared directory and nowhere locally, so putting the binding
back makes that team vanish from its owner's `/api/me`. That gives the rollback a cutoff,
and the write hold from step 4 is what marks it:

- **While the hold is on**, nothing has been written that the local DO lacks, and rollback
  is exactly the binding revert. So the hold stays on for the whole observation window —
  the reads are what the flip has to prove, and holding team creation for an hour costs
  less than a team that exists on one side only.
- **After the hold lifts**, rollback is no longer one action. It is step 2 run in the
  other direction — the same idempotent backfill with the two directories swapped, for
  every membership row written since the flip — and only then the binding revert. The
  step 2 tooling is written so it can be pointed either way for that reason, and which
  of the two rollbacks is in force is written down before the hold is lifted.

[#1343]: https://github.com/substrat-run/substrat/issues/1343
