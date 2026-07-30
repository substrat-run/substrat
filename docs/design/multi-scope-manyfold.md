# Multi-scope Manyfold, self-serve sites, and the Data-tab scope switcher

**Status:** proposal · **Motivating case:** a deployed Manyfold (CMS) app whose Data tab
shows only `_substrat_*` system tables and no content — because hosted Manyfold is
single-scope today, and even that one scope never received Manyfold's schema.

## What we found (the diagnosis this plan is built on)

- **Manyfold is designed multi-scope** — *site = scope*, one tenant owns many sites, owner
  holds `admin` tenant-wide, editorial roles held per-site
  ([`provision.ts:55-92`](../../demos/manyfold/src/provision.ts)). There is **no hub scope**;
  sites are just scopes under the tenant.
- **But hosted Manyfold is single-scope.** `createApp` provisions exactly one scope
  ([`provision.ts:742`](../../apps/dashboard/src/provision.ts)); the multi-site machinery
  (`provisionManyfold` looping `input.sites`) lives only in the dev/seed harness. There is
  **no hosted flow to add a site.**
- **The one scope is unmigrated.** The observed app scope has roles seeded but
  `_substrat_migrations = 0` and no `manyfold_*` tables — the vertical's provision migrations
  never applied to it (**"P2"**, addressed in M1).
- **Listing scopes is a platform concern.** The control-plane directory already records every
  provisioned scope; `host.admin.listScopes({ tenantId, vertical })` reads them
  ([`host.ts:219`](../../packages/adapter-cloudflare/src/host.ts)). No vertical cooperation is
  needed to *list* — only to read a scope's *data* (already `/internal/tables?scopeId=`).
- **Sandbox-clean verticals have no upward channel.** `assertSandboxContract` refuses a
  `CONTROL_PLANE` binding and service bindings by name; the vertical only *receives*
  `PLATFORM_SECRET`-authenticated calls ([`worker.ts:1-16,157`](../../demos/manyfold/src/worker.ts)).
  So a vertical **cannot itself provision a scope** — provisioning authority stays on the platform.

## Decisions locked

1. **App scope = the default site (site #1).** Faithful to Manyfold's no-hub model; the app
   scope holds content from day one. The current empty scope is therefore a **bug to fix**
   (M1), not an intended hub.
2. **Self-serve via Path 1 — in-app entry, platform-mediated provisioning.** The "New site"
   action lives in Manyfold's UI (owner-only) but hands off to a **tenant-narrowed builder
   route** on the control plane that does the provisioning. The vertical stays sandbox-clean;
   the *builder* principal (a tenant-scoped actor, already fail-closed-allowlisted) is the
   authority. No new vertical→platform channel.
3. **Site registry lives in the per-tenant AUTH/Identity DO.** The vertical's own site switcher
   is CP-less and cannot call `listScopes`; it reads its site list from the per-tenant DO that
   already exists and survives scope wipes ([`worker.ts:91`](../../demos/manyfold/src/worker.ts)),
   populated on each `/internal/provision`.

## Milestones

### M1 — Multi-scope provisioning + fix the migration gap  *(foundation)* — #356, #355

Platform side, reusing the proven `provisionScope` + `provisionInstance` sequence:

- **New builder route** `POST /tenants/:tenantId/scopes` in
  [`api.ts`](../../packages/control-plane-api/src/api.ts): add to `BUILDER_ROUTES` (the
  reachability allowlist) and, in the handler, **force `input.tenantId = principal.tenantId`**
  (mirroring the hostname handlers' tenant-narrowing; foreign tenant ⇒ 404, existence-hiding).
  Body branches from the existing staff `POST /scopes` handler (~api.ts:598).
- **Quota gate (optional, server-side):** count existing scopes via
  `admin.listScopes({ tenantId, vertical })` against the tenant's `sites` entitlement `quota`
  (`quota` already exists on `entitlementGrant`, [`control-plane.ts`](../../packages/contracts/src/control-plane.ts),
  but is "never enforced here" — enforce it in this privileged handler).
- **Dashboard authority:** add a `provisionSite`-style method to `TenantNarrowedControlPlane`
  ([`authority.ts`](../../apps/dashboard/src/authority.ts)); it already pins `tenantId`.
- **P2 — verify migrations apply on the site-provision path.** `provisionInstance` →
  `/internal/provision` → `provisionScopeLocal` → `migrateAndRecord` → `stub.migrate()` should
  create the `manyfold_*` tables and journal them. Reproduce the "roles but zero migrations"
  state and fix the cause before shipping self-serve — a broken migrate path would make every
  new site as empty as the current one.

**Exit:** a second scope can be provisioned under an existing app's tenant, tenant-narrowed,
and it comes up with Manyfold's schema.

### M2 — Site registry + Manyfold's own site switcher — #357

- **Registry:** on each `/internal/provision`, record the site in the per-tenant AUTH/Identity
  DO (`scope_id`, `slug`, `name`, `created_at`). One writer, survives scope-DO wipes.
- **`GET /api/sites`** in [`worker.ts`](../../demos/manyfold/src/worker.ts): read the registry,
  replacing the static `world.sites` the dev server returns
  ([`server.ts:67`](../../demos/manyfold/src/server.ts)).
- **Site switcher** in Manyfold's UI (already the intended shape in `manyfold-ui.md`), picking
  the active scope via the existing `x-scope` header ([`worker.ts:79-81`](../../demos/manyfold/src/worker.ts)).

**Exit:** the app's own UI lists and switches between real sites.

### M3 — In-app "New site" (Path 1 handoff) — #358

- **Owner-only "New site"** in Manyfold's UI that deep-links to a dashboard builder flow
  (e.g. `app.substrat.net/#/apps/:id/sites/new`). The tenant owner who installed Manyfold *is*
  the builder, so they carry the right principal on the platform.
- The dashboard flow calls the **M1 route**, then redirects back to Manyfold with the new site
  selected (`x-scope`). The vertical never provisions — it navigates the owner to the platform
  surface that does.

**Exit:** an owner creates a new site from the product without leaving the experience, and
lands in it ready to add content.

### M4 — Dashboard Data-tab scope switcher — #359

Now that an app can have >1 scope, make the Data tab honest:

- **Worker route** `GET /api/apps/:scopeId/scopes` → resolve caller tenant (as the tables route
  already does, [`worker.ts:1184`](../../apps/dashboard/src/worker.ts)) → return
  `host.admin.listScopes({ tenantId, vertical: app.vertical_slug })`, the viewed scope default.
- **Client** `api.appScopes(appScopeId)`.
- **UI (`DataBrowser`)** — a scope `<select>` above the table list, shown when >1 scope; it swaps
  the `scopeId` fed to the **existing** `appTables` / `appTableRows` / `appQuery` calls. Read path,
  permissions, and audit are unchanged (already per-`scopeId`).

**Exit:** the Data tab shows every scope of the app and lets you browse each.

## Explicit non-goals (what this does NOT standardize)

- **No new vertical→platform channel.** Provisioning authority stays on the platform (Path 1);
  the sandbox contract is untouched. (Path 2 — a tenant-pinned upward capability — is a possible
  future K-decision, deliberately deferred.)
- **No `/internal/scopes` verb / no per-vertical scope registry for the dashboard.** The Data-tab
  list is a control-plane directory read.
- **No user-facing routing convention imposed on verticals.** How a vertical maps a request to a
  scope (`x-scope`, hostnames) stays its own concern.
- **No scope-topology standard.** The switcher renders a flat list; hierarchy is out of scope.

## Open questions

- **Identity handoff details (M3):** confirm the installing owner reliably holds a builder
  session on `app.substrat.net` when clicking through from the vertical origin; cross-origin
  cookie/domain specifics (`substrat:auth.cookieDomain`) need a concrete redirect design.
- **Scale:** `listScopes`/`GET /api/sites` return all of a tenant's scopes. Fine at tens; a
  vertical with thousands of scopes per tenant needs paging/search — note, don't build yet.
- **Quota policy:** is there a per-plan site cap to enforce in M1, or is site count unmetered for
  now? Needs a product call before wiring the gate.

## Tracking

Epic #360 · milestones #356 (M1) · #357 (M2) · #358 (M3) · #359 (M4) · bug #355 (unmigrated scope).
