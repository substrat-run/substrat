# @substrat-run/control-plane-api

## 0.34.0

### Minor Changes

- ab637f0: Per-tenant relational stores go live on Cloudflare (#301 PR-2). `provisionTenantStore`
  now mints a real D1 per (tenant, vertical, binding) (`createD1TenantStores`, on the
  platform credential), records it in the directory's `tenant_stores` ledger, and the
  provision endpoint hands the K-31 callback the declared handles automatically — the
  worker reaches its tenant's store through a real `d1` binding named
  `tenantStoreBindingName(binding, tenantId)` (new in contracts), attached at provision
  via the WfP settings PATCH (`createWfpBindingsPatcher`) and re-derived from the ledger
  on every in-place serving upload so a re-deploy can never drop it. `openTenantStore`
  on the Cloudflare host is the out-of-band D1 HTTP-query reach;
  `d1TenantRelationalStore` wraps the worker-side binding in the substrate store shape.
  Contract change: `TenantRelationalStore.query/exec` are now async — D1 has no sync
  path, and PR-1's sync shape was satisfiable only by SQLite. New read:
  `HostAdmin.listTenantStores` (both adapters).

### Patch Changes

- Updated dependencies [ab637f0]
  - @substrat-run/contracts@0.34.0
  - @substrat-run/kernel@0.34.0

## 0.33.0

### Minor Changes

- 0b9220e: Refuse the silent lineage fork (#388). A first push of a registry id that doesn't exist yet, whose product name matches an existing lineage the push could confuse itself with (platform-owned, marketplace-listed, or the acting workspace's own), is now refused with the fix named — package.json `substrat.slug`/`substrat.tenant` decide where a push lands — instead of quietly creating a second same-named vertical whose pushes the existing installs never see. `substrat push --allow-fork` makes a deliberate second lineage explicit. Same-name-under-another-tenant stays allowed (each tenant's namespace is its own), and a builder is never told about a foreign private slug. The CLI also prints a pin-it hint while the slug is derived from the package name (a rename would fork the lineage, #399), and surfaces the control plane's refusal text directly instead of raw JSON.
- 6d3429e: Identity links ride the scope-local projection (#406): the control plane stays the
  audited source of truth (`linkIdentity`/`unlinkIdentity`), and every identity write now
  fans out into the tenant's projected scopes (`_substrat_identity_links`), with CP-less
  delivery on the provision/reconcile channel entitlements already use. New surfaces:
  `HostAdmin.listIdentityLinks` (the audited per-tenant gather), the
  `projectedIdentityLink` contract shape, `identityLinks` on provision/reconcile payloads,
  and `CloudflareScopeHost.resolveIdentityLocal` — the CP-less auth adapter's
  `(provider, externalId) → principal` read against the scope's own storage, replacing
  login maps compiled into the bundle (offboarding by deploy; revocation undone by version
  rollback).

### Patch Changes

- Updated dependencies [6d3429e]
  - @substrat-run/contracts@0.33.0
  - @substrat-run/kernel@0.33.0

## 0.32.0

### Patch Changes

- c0b3464: Make the lineage fork behind a silent config-delivery 501 self-diagnosing

  A `substrat push` publishes versions under the slug it derives from the project
  (`package.json` `name`, unless `substrat.slug` pins it), while installs/hostnames — and so
  a scope's `vertical` — carry the slug the app was installed under. When those diverge,
  `resolveVerticalVersion` filters a scope's bound version by the scope's slug and never
  finds it, so per-instance config delivery 501s and `substrat versions <slug>` returns
  nothing even though installs are serving. Diagnosing that took hours because nothing named
  the split.

  - **Control plane:** the config-delivery and reconcile 501s now return an actionable body
    that names the bound slug + version and the likely cause — a lineage fork (versions under
    a different slug), no pushed versions, or none promoted — instead of the bare
    "no deployment is bound". Computed only on the miss path.
  - **CLI:** `substrat versions <slug>` cross-checks installs (a slug with bound hostnames but
    zero versions prints a fork warning pointing at `package.json` `name` vs `substrat.slug`)
    and distinguishes "unknown slug" from "no versions". `substrat hostnames <slug>` prints the
    reverse warning when a slug has hostnames but no pushed versions.

  Diagnostics only — preventing the fork (consistent push/install identity) is tracked
  separately.

- Updated dependencies [99af6b6]
- Updated dependencies [070f4dc]
  - @substrat-run/contracts@0.32.0
  - @substrat-run/kernel@0.32.0

## 0.31.0

### Minor Changes

- fbf0704: Multi-scope Manyfold: archive a site.

  Rounds out scope management (create + switch were already there) with **archive**, reusing the
  platform-intent mechanism — archiving a scope is a platform action the sandbox-clean vertical can't
  do itself, so it's another intent kind:

  - **contracts:** `archive-scope` kind + `archiveScopePayload` (`{ scopeId }`).
  - **control-plane-api:** `archiveScopeHandler` — the drained scope proves the tenant; the target
    must be under that same tenant and run the same vertical (verified against the directory), then
    `host.admin.archiveScope`. Idempotent (an already-archived/absent target is a no-op success).
  - **control-plane worker:** registers `archive-scope` alongside `provision-sibling` in the drain.
  - **vertical-auth:** `IdentityDO.forgetSite` drops a site from the per-tenant registry.
  - **Manyfold:** a `manyfold/archive-site` op (`content:manage-sites` — no new permission) enqueues
    the intent; `POST /api/sites/:slug/archive` runs it as the caller, then optimistically drops the
    site from the registry so the switcher updates immediately.
  - **Manyfold app:** an admin-only **Archive** control next to the switcher (shown only when the
    tenant has more than one site); it archives the current site and switches away.

  Tested: the handler archives its target + is idempotent + refuses a cross-vertical target;
  `forgetSite` drops a site; the `archive-site` op enqueues an `archive-scope` intent and an author is
  denied. Refs #358.

- 0d79662: Multi-scope Manyfold, D2: the platform can drain Manyfold's site-creation intents end-to-end.

  Wires the platform drain (Phases B2/C) to the vertical over its `/internal` surface, completing the
  loop from D1's `request-site` producer:

  - **Manyfold worker** exposes `GET /internal/platform-requests` and
    `POST /internal/platform-requests/settle` (platform-secret gated), backed by the CP-less
    `host.listPlatformRequests` / `settlePlatformRequest` (B1) — the scope's DO lives in the vertical's
    own deployment, so the platform pulls its intents from here. Plus `POST /api/sites`, which runs
    `manyfold/request-site` as the caller (its own `content:manage-sites` gate) and returns `202` + the
    request id, tagging the response with `x-substrat-platform-request` for the router kick (Phase D3).
  - **`VerticalClient.listPlatformRequests` / `settlePlatformRequest` now take `tenantId`** (the CP-less
    vertical host reads by `(tenantId, scopeId)`); `drainScopePlatformRequests` passes it from the
    drained scope's context. A small signature change to the just-added B2 methods, contained to the
    drain path.

  So a `request-site` intent is now picked up by the periodic sweep (C) and provisioned via
  `provision-sibling` (B2), appearing in the M2 site registry within a sweep cycle. The low-latency
  router kick and the "New site" UI are Phase D3. Refs #358.

- 41d01f6: Platform intents, Phase B2: the drain engine + `provision-sibling` handler.

  The platform-side execution for `docs/design/platform-intents.md`. Because a scope's intent rows
  live in the vertical's own deployment (K-31), the platform PULLS them over the vertical's
  `/internal` surface: `VerticalClient` gains `listPlatformRequests` / `settlePlatformRequest`
  (the B1 read/settle surface, now reachable cross-deployment).

  - `drainScopePlatformRequests(client, ctx, handlers)` lists a scope's pending intents, dispatches
    each to the handler registered for its `kind`, and settles the outcome — an unknown kind settles
    `failed` (never a silent drop), a thrown handler settles `pending` (retried next drain).
  - `provisionSiblingScope(...)` extracts the exact sequence M1's `POST /tenants/:tenantId/scopes`
    route runs (inherit parent vertical/jurisdiction → provision → materialize → activate) into one
    reusable home; the route now calls it. `provisionSiblingHandler` wraps it as the
    `provision-sibling` intent handler, with two-phase idempotency (a scope id minted on an earlier
    pass is reused, so a retry targets the same sibling).
  - `contracts` gains the shared `provisionSiblingPayload` (`{ slug, name, owner }`) + the
    `provision-sibling` kind constant.

  Tested with a fake vertical transport (dispatch → settle: done / unknown-kind-failed /
  thrown-pending) and against a real SQLite host (the handler provisions + activates a sibling under
  the parent tenant, seating the owner). The triggers — the periodic sweep phase and the router kick,
  plus each vertical's `/internal/platform-requests` endpoints — are Phase C. Refs #358.

### Patch Changes

- Updated dependencies [fbf0704]
- Updated dependencies [41d01f6]
- Updated dependencies [50d9260]
- Updated dependencies [0e9eba7]
  - @substrat-run/contracts@0.31.0
  - @substrat-run/kernel@0.31.0

## 0.30.0

### Minor Changes

- 49db0a1: Self-serve multi-scope, M1: add a sibling scope to an app the tenant already runs.

  New builder-reachable, tenant-narrowed `POST /tenants/:tenantId/scopes` route on the control
  plane. It authorizes by `parentScopeId` — the existing app scope must belong to the caller's
  tenant, which proves the entitlement — and the new scope INHERITS that app's vertical and
  jurisdiction, so a caller can never name a vertical it does not already run. It then runs the
  same provision → materialize-instance (K-31) → activate sequence `createApp` runs for an app's
  first scope. A builder is confined to its own tenant (foreign tenants read as 404, K-3
  existence-hiding); staff may target any tenant. No site-count quota is enforced yet — an open
  product question tracked in the design doc. The dashboard's `TenantNarrowedControlPlane` gains
  an `addSiblingScope` method over the new route.

  Also pins a regression (#355): `provisionScopeLocal` applies a scope's module migrations at
  provision time — own tables created and journaled before any first `getScope` — so a
  freshly-provisioned scope is never born content-less.

- a698959: Derive the permission registry from a typed source, and require it in the deploy manifest (D-41).

  D-39 shipped the declared permission surface in the deploy manifest but left three seams as
  convention and introduced a machine-only generated file in git. The surface was discovered by a
  by-name `MODULES`/`ROLES`/`ENTITY_GRANTS` re-export from each vertical's `seed.ts` (wrong name,
  wrong file, or a vertical outside `demos/`/`apps/` vanished from the checkpoint with no error);
  `push` read a checked-in `permissions.json` and treated its absence as a silent empty surface; and
  `deployManifest.registry` was optional, so a push could carry no declared surface at all.

  Now the surface is declared once via a typed `definePermissions({ modules, roles, entityGrants })`
  in `@substrat-run/contracts` — a compile-checked single source. The checkpoint tool discovers it
  from a declared `package.json` `substrat.permissions` pointer rather than a `seed.ts` re-export
  (a package with a `seed.ts` but no pointer is now a hard error, not a silent skip), and emits only
  the human-readable `PERMISSIONS.md`. The machine-readable `permissions.json` is gone from git:
  `substrat push` derives the registry from the typed entry with the same new
  `buildPermissionRegistry`, bundling the entry with esbuild (deps left external, so a node-ful entry
  still resolves its own `node_modules`) and hashing the result into `digests.permission` — proven to
  reproduce the previously-committed files byte-for-byte, so the digest is unchanged.

  `deployManifest.registry` is now **required**: a push that declares no surface is rejected at the
  trust boundary and by the CLI before upload (absence is never a silent empty registry; a vertical
  that genuinely exposes nothing ships an explicit empty registry). A lenient `storedDeployManifest`
  (registry optional) is used only for re-reading manifests persisted before this change, so old
  versions stay readable and re-deployable in place. `@substrat-run/cli` gains an `esbuild`
  dependency.

- 866c46d: Per-PR preview instances for private verticals (preview-and-snapshots.md §2/§9, D-43).

  Open a PR → a preview instance running the PR's pushed code against a **fork of the
  tenant's prod data**, on its own `<label>--pr-N.<base>` URL; close the PR → it's reaped
  (with a per-preview `expiresAt` as the GC backstop). Also drivable by hand from the CLI.

  - **control-plane-api**: `orchestratedPreview` + three builder-reachable routes —
    `POST/GET/DELETE /verticals/:slug/previews`. Create forks the source prod scope (the
    §9 cross-version path: export from where prod data lives → import into the PR version's
    deployment), binds the pushed version to the fork, and mints a non-canonical preview
    hostname; delete delegates to the existing fork-reap. Gated `global`-jurisdiction only
    (K-32) with the canonical audited export path. Private verticals only — a private
    push self-admits (D-36), so no admission relaxation is needed.
  - **cli**: `substrat preview create|delete|ls`. `create` pushes the working tree, then
    forks + binds; re-running the same `--tag` rebinds onto the same fork so a PR's
    successive pushes roll migrations forward on one copy (`--refresh` re-forks). Uses the
    existing tenant-scoped push token — no new credential.
  - **dashboard**: the generated `substrat-deploy.yml` gains `pull_request` jobs —
    create/update the preview on open/synchronize (and comment the URL back), reap it on
    close — alongside the existing push-to-branch prod deploy.

### Patch Changes

- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
  - @substrat-run/contracts@0.30.0
  - @substrat-run/kernel@0.30.0

## 0.29.0

### Minor Changes

- a650d52: Dashboard permissions view + version-to-version admission diff (#336, D-39).

  The permission registry a vertical declares has shipped inside the deploy manifest
  since #299 (`manifest.registry`: keys+descriptions, role templates, entity-grant
  shapes), but nothing consumed it — a tenant installing or updating an app could not
  see what permissions and roles it declares. This adds the tenant-facing view #299 left
  as a follow-up, with no new backend plumbing beyond a read path.

  - **control-plane-api**: a new owner-narrowed `GET /verticals/:slug/versions/:id/registry`
    reads one version's declared permission surface out of its retained manifest (null for a
    pre-#286 version, or one that declares no surface). Owner-narrowed exactly like the
    versions list — a builder reading a vertical it does not own gets a 404. Read-only: the
    promotion permission-diff checkpoint stays the human gate.

  - **dashboard**: `GET /api/apps/:scopeId/permissions` resolves the registry of the version
    the app actually runs (its pinned version, the router's truth) plus the prod-head update
    target's, through the tenant-narrowed control plane (connected) or the retained manifest
    (embedded). A new **Permissions** tab renders the declared surface — keys grouped by
    declaring engine (key → description → the roles that hold it), role templates, and
    entity-grant **shapes** (the per-principal grants themselves stay a runtime concern) —
    and, when an update is available, a version-to-version diff flagging new/removed/
    re-described keys and **widened roles**. Absent-registry (D-28 optional), no-roles, and
    no-running-version cases render explicitly rather than crashing.

  This is the tenant-facing rendering of the permission-diff human checkpoint: the tab
  displays, but approving a widened role stays a human decision made when updating on the
  Deployments tab.

- c64bdf8: Builder-facing recovery for a scope stranded at "roles projected, zero tuples" (#332).

  A CP-less hosted scope could be left with its role definitions projected and
  `permission_source = 'local'` but no principal holding a role — so strict local
  enforcement evaluated against an empty tuple table, every login was denied, and the
  builder who owned the vertical had no lever to fix it (`/internal/provision` is gated by
  the platform's secret, which is correctly never theirs). This closes the hole with a
  prevention and a repair, and never hands a builder `PLATFORM_SECRET`.

  - **Provision is atomic now.** `applyProjection` gains an additive `scopeTuples` argument,
    and `provisionScopeLocal` writes the owner's role grant in the **same** enqueued unit as
    the enforcement flip rather than a follow-up `writeTuple` — so a drop between the two can
    no longer strand a scope. An empty-tuple **guard** refuses to switch on strict local
    enforcement when roles are projected but no live principal→role grant exists (across
    scope- and tenant-level tuples), backstopping every projection path.

  - **The vertical remembers its owner.** `@substrat-run/vertical-auth`'s IdentityDO adds a
    durable `owner_of_record` seat (set at provision, never consumed — unlike `pending_owner`,
    which the first login claims). It lives in the per-tenant IdentityDO, a different DO from
    the scope's data DO, so it survives a scope-DO storage wipe (e.g. a promote, #321).

  - **A builder can trigger the repair.** New `POST /tenants/:tenantId/scopes/:scopeId/provision`
    on the control-plane API — builder-reachable (allowlisted **and** ownership-checked: a
    builder may only reconcile a scope running a vertical its own tenant owns) — re-gathers the
    tenant's entitlements and delegates to the vertical's new `/internal/reconcile`, which
    re-sources the owner from `owner_of_record` and re-runs the idempotent provision. The CP
    holds the platform secret and makes the call on the builder's behalf; a scope with no owner
    of record refuses actionably (409) rather than pretending. Surfaced as
    `substrat scope provision <scopeId>`, authenticated with the builder's existing CP token.

  - **`scope restore` is actionable.** The CLI now surfaces the control plane's `detail` on a
    failed restore instead of collapsing it to a bare message.

  Demo verticals `meridian` and `manyfold` carry the reference `/internal/reconcile` handler.
  Console visibility of provisioning state (roles-only / unprovisioned) is a follow-up.

### Patch Changes

- @substrat-run/contracts@0.29.0
- @substrat-run/kernel@0.29.0

## 0.28.0

### Minor Changes

- d696b78: Builder-facing recovery for a scope stranded at "roles projected, zero tuples" (#332).

  A CP-less hosted scope could be left with its role definitions projected and
  `permission_source = 'local'` but no principal holding a role — so strict local
  enforcement evaluated against an empty tuple table, every login was denied, and the
  builder who owned the vertical had no lever to fix it (`/internal/provision` is gated by
  the platform's secret, which is correctly never theirs). This closes the hole with a
  prevention and a repair, and never hands a builder `PLATFORM_SECRET`.

  - **Provision is atomic now.** `applyProjection` gains an additive `scopeTuples` argument,
    and `provisionScopeLocal` writes the owner's role grant in the **same** enqueued unit as
    the enforcement flip rather than a follow-up `writeTuple` — so a drop between the two can
    no longer strand a scope. An empty-tuple **guard** refuses to switch on strict local
    enforcement when roles are projected but no live principal→role grant exists (across
    scope- and tenant-level tuples), backstopping every projection path.

  - **The vertical remembers its owner.** `@substrat-run/vertical-auth`'s IdentityDO adds a
    durable `owner_of_record` seat (set at provision, never consumed — unlike `pending_owner`,
    which the first login claims). It lives in the per-tenant IdentityDO, a different DO from
    the scope's data DO, so it survives a scope-DO storage wipe (e.g. a promote, #321).

  - **A builder can trigger the repair.** New `POST /tenants/:tenantId/scopes/:scopeId/provision`
    on the control-plane API — builder-reachable (allowlisted **and** ownership-checked: a
    builder may only reconcile a scope running a vertical its own tenant owns) — re-gathers the
    tenant's entitlements and delegates to the vertical's new `/internal/reconcile`, which
    re-sources the owner from `owner_of_record` and re-runs the idempotent provision. The CP
    holds the platform secret and makes the call on the builder's behalf; a scope with no owner
    of record refuses actionably (409) rather than pretending. Surfaced as
    `substrat scope provision <scopeId>`, authenticated with the builder's existing CP token.

  - **`scope restore` is actionable.** The CLI now surfaces the control plane's `detail` on a
    failed restore instead of collapsing it to a bare message.

  Demo verticals `meridian` and `manyfold` carry the reference `/internal/reconcile` handler.
  Console visibility of provisioning state (roles-only / unprovisioned) is a follow-up.

### Patch Changes

- @substrat-run/contracts@0.28.0
- @substrat-run/kernel@0.28.0

## 0.27.0

### Minor Changes

- 6901c16: Per-tenant relational stores as a first-class store type (#301, PR-1).

  A hosted vertical whose data model is one SQL database **per tenant** (a latency-sensitive
  multi-tenant auth/OIDC provider is the motivating case) can now declare a per-tenant
  relational store the platform provisions and hands over — distinct from a single shared D1
  (one database for every tenant) and from an own DO (one per scope). Because the platform
  mints the database per tenant and injects the id, the builder supplies **no `database_id`**:
  that is what closes the ownership gap a bundle-chosen id left open (self-serve-deploy.md §4).

  - **Vocabulary** — `tenantStoreNeed` in `runtimeNeeds.tenantStores` and a platform-minted
    `tenantStoreHandle` (`@substrat-run/contracts`). A per-tenant store is a _need_ the platform
    provisions, never a `declaredBinding`, so it never rides the §4 sandbox allowlist. The CLI
    carries `tenantStores` into the deploy manifest without emitting a static wrangler binding.
  - **The seam** — `provisionTenantStore` (platform mints, records in the directory, returns an
    opaque handle; idempotent) and `openTenantStore` (the vertical opens what it was handed and
    runs its own migrations) on `ScopeHost`, plus `ProvisionInstanceInput.tenantStores` so the
    K-31 pull-provision callback hands the handle over inside its fail-closed/idempotent/retry
    ready-gate. The handle's `ref` is opaque — a D1 `database_id` on Cloudflare, a per-tenant
    `.sqlite` file on the pure adapter.
  - **Pure adapter (real)** — `@substrat-run/adapter-sqlite` mints one separate `tstore__….sqlite`
    file per (tenant, vertical, binding), physically isolated from the scope DBs, backed by a
    new `tenant_stores` directory table (the idempotency + reap ledger). The whole path is
    exercised in dev/CI without Cloudflare.
  - **Cloudflare (stubbed)** — `@substrat-run/adapter-cloudflare` throws a clear `#301` marker
    from `provisionTenantStore`/`openTenantStore`; live D1 create/bind/HTTP-query is the tracked
    follow-up (PR-2), so nothing appears provisioned while its store does not exist.

  Additive and backward-compatible: `runtimeNeeds.tenantStores` and the manifest field default
  to empty, a `provisionTenantStore` audit action is a new enum value, and a vertical that
  predates `ProvisionInstanceInput.tenantStores` strips the unknown key.

### Patch Changes

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0
  - @substrat-run/kernel@0.27.0

## 0.26.0

### Minor Changes

- 2bdd22b: Custom-hostname issuance end-to-end + registrable-suffix (PSL) enforcement (#305).

  Binding a custom domain to a surface is no longer a bare `pending` row that a human flips
  to `active` by hand. The control plane now drives Cloudflare for SaaS through the real
  lifecycle — `pending → verifying → active | failed` — and enforces the registrable-suffix
  isolation D-35 has always specified but never checked in code.

  - **A `CustomHostnameProvisioner` seam** (`packages/control-plane-api/src/custom-hostnames.ts`)
    wraps the Cloudflare `custom_hostnames` API in pure web-standard `fetch`, injected into
    `createControlPlaneApi` exactly like the WfP uploader — so the transport holds no
    Cloudflare credential and the builder never holds one (D-34). Binding a **custom** domain
    calls `create` (→ `verifying`, storing the DNS records the tenant must publish); a
    **platform** mint under `PLATFORM_BASE_DOMAINS` rides the wildcard cert and goes straight
    to `active` with no per-hostname call.

  - **A scheduled reconcile pass** (`reconcilePendingHostnames`, wired into the control-plane
    worker's `scheduled()`) polls every `verifying` domain to `active`/`failed` and retries
    any stuck `pending` custom bind — issuance self-heals without a human. A new
    `POST /hostnames/:hostname/verify` route (and `substrat hostnames verify`, and the
    dashboard's _Check again_) re-polls on demand.

  - **New `@substrat-run/psl`** vendors the Public Suffix List + the canonical matching
    algorithm (no runtime fetch, web-standard only). `resolveCookieDomain` now rejects a
    cookie whose Domain is a public suffix (`co.uk`, `pages.dev`) — a real guard where the old
    label-count check waved multi-level suffixes through — and `bindHostname` refuses a custom
    domain that is a bare public suffix.

  - **Contract + storage.** `hostnameBinding` gains `customHostnameId` and `validationRecords`
    (additively, defaulting to null/[]), plus a `verifying` status and a `dnsRecord` shape. Both
    adapters get the two columns (additive ALTER), a `setHostnameIssuance` writer, and a
    `status` filter on `listHostnames` (index-backed) for the reconcile pass.

  - **The dashboard Domains view is wired to the live control plane** (`/api/domains`): list,
    add a custom domain (shows the DNS records to publish), _Check again_, and remove — no more
    mock rows. Removing a custom domain releases the Cloudflare custom hostname.

  Absent a SaaS zone (dev / self-host), a custom bind records `pending` and issuance simply
  does not run — existing behavior is unchanged until `CF_SAAS_ZONE_ID` is configured.

### Patch Changes

- 03839ec: Unmapped 5xx from the control plane are now logged server-side, so a `substrat push` that
  fails with a bare `500 {"error":"internal error"}` is diagnosable without reproducing it.

  `mapError` deliberately returns a GENERIC body for any throw whose message it does not
  recognise (an unreviewed message on a cross-tenant surface must disclose nothing). Until now
  nothing recorded WHAT threw either, so an unmapped failure was opaque from both sides. The
  concrete case that surfaced this: a single registry row with malformed `env_spec`/`install_spec`
  JSON makes `mapVertical`'s `JSON.parse` throw a `SyntaxError` (not a `ZodError`, so it skips the
  400 branch) — and because `ownerOf` → `listVerticals` maps every row on the pre-upload owner
  check, that one bad row 500s _every_ builder deploy with no detail.

  `onError` now emits `control-plane.unhandled { method, path, detail, stack }` for any 5xx before
  returning the generic body. The client response is unchanged (still generic — nothing is
  disclosed); the worker tail now names the cause. Mapped 4xx are honest refusals and stay unlogged.

- Updated dependencies [2bdd22b]
  - @substrat-run/contracts@0.26.0
  - @substrat-run/kernel@0.26.0
  - @substrat-run/psl@0.2.0

## 0.25.0

### Minor Changes

- e612b98: Reap archived scopes (§4.4): free the Durable Object storage that Cloudflare never
  garbage-collects. Deleting an app archives its scope — a tombstone-only transition that
  keeps the directory row but leaves the scope DO holding every byte forever. This adds a
  terminal `reaped` state past `archived`: `reapScope` wipes the DO's storage while keeping
  the directory row (audit history + burned slug), the one irreversible scope transition, so
  it only ever leaves `archived`, `getScope` fails closed on it, and its slug is released for
  reuse. Delivered two ways over one seam — the storage wipe reaches the vertical's own
  deployment (a hosted scope's DO is CP-less) via the same `deleteScope` dispatch the snapshot
  GC uses: a staff-only `POST /tenants/:t/scopes/:s/reap` (armed in the console behind a
  type-the-slug dialog, since there is no restore), and a `runPlatformSweep` phase that reaps
  scopes archived longer than `SCOPE_RETENTION_DAYS` — opt-in and unset by default, because
  the reap cannot be undone. Both adapters gain an additive `archived_at` column (stamped on
  archive, cleared on unarchive) to age the sweep, and their `(tenant_id, slug)` unique index
  becomes partial on the live statuses so a retained tombstone never blocks the slug reuse the
  pre-check already intends — closing a latent gap where archived slugs could not actually be
  reclaimed.
- caedb1c: A prod promote no longer strands a legacy scope's data, and the in-place serve is honest and
  complete end-to-end (#321). #287 shipped the serve-in-place, but existing (pre-#286) scopes were
  never migrated onto the stable serving script, so every promote re-stranded them: the private-
  vertical rebind cascade advanced a legacy scope's version to the incoming version's fresh,
  empty per-version dispatch script, `0001-init` re-ran against empty storage, and the app rendered
  a no-access page that read as an auth bug rather than data loss.

  - **Adopt-before-rebind on promote.** For a dispatch-backed vertical, the host rebind cascade is
    skipped (an embedded vertical, with no per-version script, keeps it) and the control-plane-api
    prod-promote handler owns adopt-then-rebind in the correct order: after a successful in-place
    serve, each still-legacy owned scope is adopted onto the stable serving script — its bytes moved
    off the per-version script _before_ any version pointer advances — then rebound. Retry-safe:
    nothing rebinds until the adopt succeeds, so a failed serve strands nothing and a re-promote
    resumes. A shared `adoptScopeOntoServing` primitive backs both this and the explicit endpoint.

  - **A builder-triggerable backfill for existing installs.** `substrat scope adopt-serving <scopeId>`
    migrates one legacy scope; `--vertical <slug>` (and `POST /verticals/:slug/adopt-serving`)
    backfills every still-legacy scope of a vertical. Idempotent.

  - **`scope restore` accepts an adapter-sqlite scope file and errors actionably.** `importDump`/
    `loadDump` re-assert the kernel spine after the drop-then-replay, so a dump that omits
    `_substrat_roles`/`_substrat_tenant_tuples` (an adapter-sqlite scope file keeps them in its
    directory db) no longer leaves the target missing spine tables and crashing a later check with a
    bare `no such table` → the detail-less `internal error` the field report hit. The restore route
    returns an actionable 422 instead of the generic 500.

  - **A failed in-place serve stops reading as "deployed."** `servingVersionId` is added to the
    channel surface (`VerticalChannel` + both adapters' `listChannels`): a prod promote moves the
    channel pointer before the serve, so when the serve fails `servingVersionId !== versionId` is the
    honest signal that the scopes still run the previous code. `substrat versions`, the dashboard
    deployments view, and the console surface the divergence and prompt a re-promote.

  - **An empty role projection is a platform condition, not only a per-app 403.** A new
    `GET /tenants/:t/scopes/:s/health` reports `roleProjectionEmpty` for an active scope whose served
    DO has zero projected roles (the silent state the field report chased through a migration-journal
    diff); the console Scopes detail raises it as a flagged condition.

  Prevents future stranding and gives a migration path for existing installs. Recovering data already
  stranded by an earlier bad promote (locating the specific prior per-version script) is a separate
  ops task, out of scope here.

- f0df69a: Tenant delete with a grace window (§4.8, #36): reclaim a deleted tenant's data instead of
  stranding it forever. `deleting` was a dead status — written once (a dashboard team-delete)
  and never consumed, so a tenant marked for deletion kept every byte. This finishes the
  lifecycle as the tenant analogue of §4.4's scope reap.

  `tenantStatus` gains a terminal `reaped` past `deleting`, and the `tenants` row gains a
  `deletingAt` timestamp (stamped on entering `deleting`, cleared on un-delete) so the grace
  window can be aged. `deleting` stays a reversible pause — every scope already fails `getScope`
  closed under a non-active tenant, so nothing is destroyed until a reap, and an un-delete (→
  `active`) restores the tenant whole. `reapTenant` (new on `HostAdmin`, directory-side only)
  clears the tenant's PII/config directory rows — identities and identity pools, membership
  tuples, roles, entitlements, orgs — and flips the row to a `reaped` tombstone, keeping the
  `tenants` row (burned slug + history) and `_substrat_admin_log` whole. It refuses any tenant
  not in `deleting`; `reaped` is unreachable via `setTenantStatus`.

  Delivered over one seam, two ways: a staff-only `POST /tenants/:t/reap` ("reap now", armed in
  the console behind a type-the-slug dialog, refused with 409 unless the tenant is `deleting`),
  and a `runPlatformSweep` phase that reaps tenants whose `deletingAt` is older than
  `TENANT_RETENTION_DAYS` — opt-in and unset by default, because the reap is irreversible. The
  per-scope byte-wipe runs above the kernel: the reaper archives-if-needed then reaps each scope
  through the existing `reapScopeFn` seam (so the control plane's orchestrated per-scope wipe
  applies for free), then clears the directory via `reapTenant`.

  Also settles #36's retention question: the admin log is the compliance witness (bokföringslagen
  §5.3) and is deliberately **never swept** — no TTL. The bound against dumping an ever-growing
  table lives on the read surface instead: `GET /admin-log` now defaults a page size (the
  in-process `auditLog` stays unbounded, so an internal caller that wants everything still gets it,
  and `nextCursor` walks the whole log).

  Full-tenant export (GDPR Art. 20 portability) is intentionally out of scope here — the per-scope
  `exportScope` seam it builds on already exists.

### Patch Changes

- 487db9a: Deploy-failure reporting is honest end-to-end (#307). A `substrat push` of a vertical that
  throws at module import time (e.g. an "api catalog drift" self-check) builds, dry-runs clean,
  uploads, and is then refused by Workers-for-Platforms with CF 10021 — and the failure that
  came back was undiagnosable in two ways.

  - **The upstream error was truncated mid-token.** The WfP error body was clipped with a bare
    `body.slice(0, 400)`, so it ended `…eka/set-budg` — no marker, no closing brace, the rest of
    the list invisible, and no way to tell a real operation name from a severed string. A new
    `clip(body, max = 2000)` helper carries the body through whole up to a generous cap and, when
    it must clip, appends an explicit `… [truncated, N chars omitted]` instead of cutting silently.

  - **A bad bundle read as a platform outage.** Every upload failure collapsed to a `502`, even a
    Cloudflare `4xx` that is the builder's own script being refused — sending the reader hunting
    for a platform problem first. The uploader now throws `DeployUploadError` carrying the upstream
    status (part of the deploy seam, `upstreamStatusOf`), and the deploy endpoint answers a runtime
    `4xx` as `422 deploy rejected` (well-formed HTTP, semantically refused — the builder's fault),
    keeping `5xx`/unknown as `502 deploy upload failed`.

  Also clarified: a version **label is consumed only on a successful upload**. The endpoint records
  the pending version _after_ the upload returns, so a push that fails at the upload step never
  registers the label and the same `--version` is reusable on retry (documented in
  self-serve-deploy.md §5). Booting the isolate at build time to catch import-time throws locally
  (the issue's third ask) is intentionally not done here — it would add a Workers runtime dependency
  to the CLI; the honest remote error is the mitigation.

- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/contracts@0.25.0
  - @substrat-run/kernel@0.25.0

## 0.24.0

### Minor Changes

- 72b1128: Entitlements express a plan (#33): the two-column SKU flag grows `expiresAt`,
  `quota`, `plan` and `grantedAt`/`grantedBy`. Expiry is the one field the kernel
  itself enforces — an expired grant fails closed at the per-invoke gate exactly as
  if revoked, checked lazily at read like tuple expiry (never swept), and the row
  stays in `listEntitlements` so a lapsed trial reads as lapsed rather than
  never-granted. Quota and tier are expression only, per the D-33 reframe: they
  describe the builder's subscription, and counting usage against them is the
  builder portal's job — which is why plan _expression_ lands ahead of billing
  (#39 stays blocked on meters). Grant calls are PATCH-shaped: omitted fields
  preserve what the row carries (a bare re-grant on an idempotent provisioning
  path cannot silently turn a trial perpetual), explicit null clears, and any
  effective change is a renewal audited with before/after. `listEntitlements` now
  returns `EntitlementGrant[]` instead of `string[]`; the PUT route accepts the
  plan as an optional body (a bodyless PUT stays the bare-flag grant); both
  adapters widen `_substrat_entitlements` with nullable columns via the existing
  ensure-column path, so legacy rows read as perpetual boolean flags — exactly
  their old semantics. The console shows and edits the plan half; Callout's boot
  mirror forwards whole grants so the shared plane never sees a trial as
  perpetual.
- 92d1aa1: The platform delivers a tenant's entitlements WITH provisioning, so a dispatched vertical
  projects them (#310) — completing the seam #304 left open.

  #304 projected entitlements into a scope but left the platform→dispatched-vertical path un-wired:
  a freshly provisioned CP-less scope received no entitlements, so its `entitlements_enforced` marker
  stayed off and the gate trusted upstream (only expiry, carried on the row, enforced locally).

  - **`ProvisionInstanceInput` gains `entitlements`**, delivered on the provision payload.
  - **The control-plane gathers them itself** at the single provision choke point
    (`POST /verticals/:slug/instances`) via `admin.listEntitlements` — platform-authoritative, never
    trusting the caller's body. Console and dashboard both route through that endpoint, so one
    injection covers every production path.
  - **The demo verticals (callout, meridian, manyfold)** parse `entitlements` (reusing the
    `entitlementGrant` contract) and hand them to `provisionScopeLocal`, which projects them and flips
    enforcement on.

  Propagation of a later grant/revoke to an already-live dispatched worker **rides a re-provision**
  (the idempotent K-31 call, the same channel role-definition changes use) rather than a new
  push-on-grant fan-out; expiry keeps enforcing locally meanwhile. A dedicated push channel stays
  available if a future SLA needs sub-re-provision revocation latency. Decision D-42.

- d4bf108: The workspace pin travels with a push and is honored, never silently reinterpreted. The
  CLI sends the project's pinned workspace (`substrat.tenant`) as a form field alongside
  the bundle; the deploy route resolves who the push is FOR before anything reaches the
  namespace. For a builder the pin must match the authenticated workspace — a mismatch is
  a 403 naming both sides, instead of a push that lands somewhere the project didn't say.
  For staff the pin is what was previously dropped on the floor: a pinned staff push now
  claims `<tenantSlug>/<slug>` owned by that tenant — prefixed, dashboard-visible, and
  self-admitting, exactly as the equivalent builder push — closing the dual-hat footgun
  where a staff-roster account (which can never authenticate as a builder, staff being the
  superset tried first) pushed verticals its own workspace could neither see nor
  self-serve. A bare slug already owned by the pinned tenant stays addressable as itself;
  unpinned staff pushes keep the platform-owned behavior; old CLIs that send no pin are
  unaffected on every path. `effectiveSlug` is now idempotent so a builder may address its
  own vertical by the full registry id a deploy response returns, and the CLI's same-run
  `--promote` uses exactly that id (with the version bump computed across both the
  prefixed and legacy-bare lineages).
- 4c275df: The hosted-vertical sandbox is a positive binding allowlist, not a denylist (#302).
  `assertSandboxContract` used to refuse a known-bad shortlist — `CONTROL_PLANE`, `service`
  bindings, cross-script DO — and allow **everything else by omission**: KV, Queues, R2, and
  analytics were never named or validated, and an unrecognized binding type sailed straight
  through. "What passes" was an emergent property of what the denylist forgot to ban, so a
  builder couldn't predict admission and the platform couldn't say what it permitted.

  Inverted: a vertical may now declare only its OWN resources, from one written set —
  `ADMISSIBLE_BINDING_TYPES` in `@substrat-run/contracts`, so the CLI can predict admission
  from the same list the control plane enforces. Permitted are its `durable_object_namespace`
  (own class only — no `script_name`, `class_name` ∈ declared `doClasses`) and own data stores:
  `d1`, `kv_namespace`, `queue`, `r2_bucket`, `analytics_engine`, plus inert `secret_text` /
  `plain_text` config. Anything else is refused **by omission**, with a message that names the
  offending binding and its type and points at self-serve-deploy.md §4.1.

  Two posture calls, now documented rather than incidental: own→own **`service` bindings stay
  rejected** (a hosted vertical is one serving script — no own sibling to bind, and platform
  reach is the router, K-27); own **`d1` stays admitted**, but its `database_id` ownership is
  still unproven and trusted under model-B human admission until platform provisioning injects
  the id (#301). `CONTROL_PLANE` is refused by **name** whatever type it claims, so a
  masquerading binding can't slip through the type check.

  `type` stays a free string at the schema layer on purpose: a refused type produces a named,
  actionable rejection instead of a generic Zod parse error. Decision D-40; §4.1 enumerates the
  full permitted/rejected/why table.

- d4bf108: Surface hostname binding is operator-facing (K-26 multi-surface exposure — the Egeryds
  EKA ask). The vertical side always worked: one scope, one worker, one bundle, and
  `readRoutedNode(...).surface` decides which app the hostname serves. What was missing
  was any way to GIVE a second surface a URL; `bindHostname` existed but nothing
  operator-facing called it.

  The dashboard's Domains tab is now real: it lists an app's bindings (hostname, surface,
  status, canonical), mints a platform hostname for a surface (`crm.global…` + `eka` →
  `crm-eka.global…`, live immediately — it rides the wildcard cert), records a custom
  domain as `pending` into the §4.2 lifecycle, and unbinds with the canonical-demotion
  rule stated in the UI. The default hostname is refused for removal — deleting the app
  retires it. Both mutations gate on `dashboard:provision-app` in the caller's own scope
  and land on the activity trail as `hostname-bound` / `hostname-unbound` (migration 0009
  widens the event CHECK, rebuild-and-copy like 0005–0008). A custom-domain form never
  accepts platform names — that path is the mint, so labels can't be squatted cross-tenant.

  The control plane's hostname routes join `BUILDER_ROUTES`, tenant-narrowed: a builder
  lists only its own tenant's rows (a foreign `tenantId` in the query loses silently),
  binds only into its own tenant, never supplies `region` (an EU-residency claim, K-30),
  and a foreign hostname on status/unbind reads 404 — indistinguishable from absent. CLI
  parity rides that: `substrat hostnames <slug>` lists an install's bindings,
  `… bind <slug> --surface eka [--domain …] [--scope …]` mints or records, `… unbind
<hostname>` removes.

  Verticals may declare their surfaces — package.json `substrat.surfaces: [{ name,
label }]` rides the deploy manifest to the registry like `envSpec` (metadata, not
  behavior, not in any digest; the anchor #111's per-surface operation-sets extend
  later). The declaration buys the Domains tab a picker instead of free text, and a
  push-time warning naming any hostname still bound to a surface the new version stopped
  declaring — the same spirit as the permission-surface gate, advisory tier. Free-text
  surfaces stay valid everywhere; declaring nothing opts out of the check.

### Patch Changes

- b06730e: Fix the in-place serve failing with "held no modules" on promote (#308). The WfP content
  reader (`createWfpModulesFetcher`) read the bundle back from a version's archive script and
  kept only parts where `value instanceof File`, with no `else`. But Cloudflare's `GET /content`
  is not an echo of the upload: a multipart module part whose `Content-Disposition` carries no
  `filename=` is exposed by the web-standard `FormData` parser (workerd and undici alike) as a
  **string**, not a `File`. Every such part was silently dropped, `modules` came back empty, and
  promote failed the in-place serve — the version was admitted but never served, leaving scopes
  pinned to the previous code.

  The reader now accepts both shapes: a string part becomes a module (`TextEncoder`-encoded),
  a `metadata` part (if present) is skipped, and the "held no modules" error reports the
  content-type and received part names so a future read-back that yields nothing is diagnosable
  from one log line. Regression test added with a hand-built multipart body that omits
  `filename=` — the shape the prior fixture, which passed filenames explicitly, could never
  reproduce. Introduced by the in-place deploy path (#286 / #287).

- Updated dependencies [72b1128]
- Updated dependencies [1cfce31]
- Updated dependencies [aa503c2]
- Updated dependencies [5a3ef82]
- Updated dependencies [4c275df]
- Updated dependencies [d4bf108]
  - @substrat-run/contracts@0.24.0
  - @substrat-run/kernel@0.24.0

## 0.23.0

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0
  - @substrat-run/kernel@0.23.0

## 0.22.0

### Minor Changes

- bc6d0fa: In-place deploys (#286, K-33): version updates carry scope data forward. Verticals now
  serve from ONE stable dispatch script per vertical — a prod promote re-uploads the
  promoted version's bundle onto that unchanged name (modules read back from the
  per-version archive script, metadata from the version's retained manifest), so scope
  DOs and their data stay put while the code moves, and kernel migrations finally run in
  place. In-place uploads keep existing secrets (`keep_bindings`) and send only the
  DO-class delta, diffed against directory-recorded serving state. Routing is per-scope
  truth (`scopes.servingRef`, COALESCEd over the bound version's ref); new scopes are
  born on the serving script, legacy scopes hop once via the new adopt-serving endpoint
  (export → restore → flip, data-first). Safety net: versions carry a code-only vs
  schema-change signal (migration-digest diff), the scope DO takes a PITR bookmark
  immediately before an upgrade's migration pass, and a new audited, time-boxed rewind
  (`rewindScope`, 24h window unless forced) restores schema and data to that instant.
  New `/internal/bookmarks`, `/internal/rewind` (and Meridian's previously missing
  `/internal/restore`) vertical routes; new `HostAdmin` methods (`verticalServing`,
  `setVerticalServing`, `versionManifest`, `setScopeServingRef`,
  `scopeMigrationBookmarks`, `rewindScope`).

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0

## 0.21.0

### Minor Changes

- 3354e26: Restores heal their own permission model: `CloudflareScopeHost.projectRolesLocal`
  re-applies a vertical's code-defined role definitions to one scope (scope-level
  tuples untouched), and `VerticalClient.restoreScope` now carries `tenantId` so a
  vertical's `/internal/restore` can invoke it after the import. A dump captured from
  a CP-full world carries tuples but an empty roles table — without the repair, every
  check denies while /me still names the role.

### Patch Changes

- @substrat-run/contracts@0.21.0
- @substrat-run/kernel@0.21.0

## 0.20.0

### Minor Changes

- a39a024: Backup restore / backout (§8's write half): `ScopeHost.restoreScope` loads a
  `ScopeDump` into an EXISTING scope in place (drop-then-replay, migration frontier
  included) — audited as `restoreScope`, refusing unknown scopes. Threaded end to end:
  `restoreScopeLocal` on the Cloudflare host, `/internal/restore` on the vertical
  surface (VerticalClient + the Manyfold reference worker), a staff-only
  `POST /tenants/:tenantId/scopes/:scopeId/restore` control-plane route that delegates
  to the bound version's deployment, and `substrat scope restore <scopeId> --file
<backup>` — accepting a `scope pull` .sqlite, a local adapter-sqlite scope file, or
  a .dump.json.

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [b4a6bee]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/kernel@0.19.0

## 0.18.0

### Minor Changes

- d18a247: `HostAdmin.setTenantName` + `PATCH /tenants/:tenantId` — a display-only rename (the
  slug, which registry ids key on, never moves). The dashboard's identity mirror uses
  it to keep the shared directory's tenant names in step with team names, so the CLI's
  workspace picker shows the organization, not a placeholder; the CLI now lists
  workspaces name-first.

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0

## 0.17.0

### Minor Changes

- 983c06d: Identity-mirror routes (`PUT`/`DELETE /tenants/:tenantId/identities`): the seam the
  Dashboard writes builder identity links through, so the shared plane's whoami/builder
  auth can resolve a CLI session to its workspaces. Service/staff only — not in the
  builder allowlist.

### Patch Changes

- @substrat-run/contracts@0.17.0
- @substrat-run/kernel@0.17.0

## 0.16.0

### Minor Changes

- b23c0a7: The Data tab grows a SQL console (#219): `HostAdmin.queryScope` runs ONE read-only SQL
  statement against a scope's own database, next to the table-shaped reads that stay safe
  by construction. User SQL reaching the DB moves the safety to statement-level
  enforcement, in two layers shared across adapters:

  - the kernel's `assertReadOnlyQuery` — a comment/string/identifier-aware token scan
    that rejects multi-statement input, a first keyword outside SELECT/WITH/VALUES/
    EXPLAIN, and any bare write/DDL/session verb anywhere (`WITH … INSERT INTO` is valid
    SQLite, so the first keyword alone proves nothing); deliberately over-strict, since a
    false positive costs a quoted identifier and a false negative forges the spine;
  - an adapter-authoritative backstop: better-sqlite3's `prepare().readonly`
    (sqlite3_stmt_readonly) on the pure adapter, and a transaction that ALWAYS rolls
    back inside the ScopeDO, whose `exec` has no read-only flag.

  Results are positional rows capped at `SCOPE_QUERY_ROW_MAX` (200) with a `truncated`
  flag — a ceiling, never an error. Same K-3 (tenantId, scopeId) cross-check and K-24
  access log as the table reads; the logged argument is the SQL itself. The refusal
  message prefix (`read-only console:`) is contract — pinned by the shared suite against
  both adapters and mapped to 400 by the transport.

  Transport: `POST /tenants/:tenantId/scopes/:scopeId/query` with the same
  vertical-delegation as the table reads (`VerticalClient.queryScope` →
  `/internal/query`); a vertical that cannot answer safely refuses with its own status,
  relayed verbatim — auth-server keeps refusing via its `/internal/*` 501 catch-all,
  because its DO redacts secret-bearing columns on table reads and arbitrary SQL would
  walk around the redaction. Editing rows stays out of scope forever: a write here would
  bypass the event log and forge the spine.

### Patch Changes

- 81e9408: The deploy manifest becomes a shared contract (#190 part A): `deployManifest` and
  `DeclaredBinding` move from `control-plane-api` into `@substrat-run/contracts`, and
  BOTH ends of the push seam now speak the same schema — the CLI parses the manifest it
  builds with `deployManifest.parse(...)` before uploading, the control plane re-parses
  it at the trust boundary and runs the §4 sandbox contract against the result.

  Before this, `push.ts` hand-rolled a parallel manifest object against a local
  `DeclaredBinding` interface while the server parsed the real Zod schema — a drift
  hazard on the deploy trust boundary, where a shape mismatch surfaced only as a 4xx
  from the deploy endpoint. Now drift is a compile error (shared types) or a local parse
  failure before any bytes are uploaded; a CLI-side effect is that registry metadata
  (`envSpec`, `ownerGrants`, `provides`, `requires`) is validated at push time too.

  `control-plane-api` re-exports the schema and types unchanged, so hosts keep importing
  from the transport package. The CLI gains its first runtime dependency
  (`@substrat-run/contracts`) — deliberate: the alternative was the drift. Part B of
  #190 (a substrate-neutral `runtimeNeeds` manifest section) stays open, gated on the
  product decision the issue describes.

- Updated dependencies [b23c0a7]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0

## 0.15.0

### Minor Changes

- 297e057: Observability, views 1–3 of design/observability.md — piggyback Cloudflare, stamp
  what only we know:

  - **Seam + Cloudflare reader** (`control-plane-api`): a provider-neutral
    `ObservabilityReader` contract (service/namespace vocabulary, never
    script/dispatch-namespace) with `createCfObservabilityReader` as the injected
    Cloudflare implementation (GraphQL invocation analytics + the Workers
    Observability telemetry query API) — the `DeployVerticalFn`/`wfp.ts` pattern, so
    an APM/OTel backend can slot in behind identical routes later. Two staff-only
    proxy routes: `GET /observability/metrics` and `GET /observability/logs`
    (501 when no backend is configured; deliberately not in `BUILDER_ROUTES`).
  - **Router**: one Analytics Engine datapoint per resolved request — index
    `tenantId`, blobs `(vertical, scope, surface, statusClass, rayId)`, doubles
    `(durationMs, status)` — plus a structured JSON log line with the same fields.
    The router is the only place that knows which tenant a request belonged to;
    written now so tenant-keyed history accrues before any tenant-facing read path
    exists. Metering never fails a request, and error paths are counted.
  - **WfP uploads**: pushed verticals get `observability: { enabled: true }`, so
    builder logs exist to query.
  - **Console**: an Observability fleet view — per-service invocations, error
    rates, CPU quantiles, and a row-click recent-logs panel.
  - **Dashboard**: a Traffic panel on the Verticals view showing the team's own
    deployed versions (requests/errors/CPU + recent logs). Owner-narrowing lives in
    `TenantNarrowedControlPlane`: metrics rows are filtered to owned deployment
    refs and mapped back to (vertical, version); a logs query for an unowned ref
    answers `[]` without ever reaching the plane.

  Deploy notes: the control plane's `CF_API_TOKEN` additionally needs **Account
  Analytics: Read** and **Workers Observability: Read**; the router redeploy picks
  up the `substrat_router` AE dataset binding (auto-created on first write).

- d93e690: Detachable vertical auth (docs/design/vertical-auth-detach.md): auth moves out of the
  verticals and becomes an install-time choice — a team Auth Server app or any external
  OIDC issuer — with `builtin` (embedded Better Auth) as the unchanged default.

  **auth-server** is now a real multi-instance vertical: one issuer DO per scope behind
  the router (own users, signing secret, JWKS per install), the fixed-name single issuer
  standalone. It implements the K-31 surface (`/internal/provision`, `/internal/configure`)
  and answers unknown `/internal/*` paths with JSON — never the SPA fallback that
  surfaced as "Provisioning failed — internal error".

  **Config delivery seam** (control-plane-api): `VerticalClient.configureInstance` +
  `POST /tenants/:t/scopes/:s/configure` deliver per-instance config to the deployment
  holding the scope's DO (bound-version resolution, 501 when there is nowhere to deliver);
  `ProvisionInstanceInput` gains optional `config` so an app arrives configured
  atomically. The dashboard Env tab now delivers after authoring (`delivered` flag).

  **RP flow** (vertical-auth): `oidcRpAuthProvider` — the full server-side
  Authorization-Code + PKCE relying party as an `AuthProvider`, cookie sessions signed
  with a per-tenant DO-minted secret, bearer fallback for API clients. The IdentityDO
  stores platform-delivered per-scope config and keeps the provider-agnostic
  `sub → principal` directory (TOFU owner claim + invites) under every mode. Meridian
  selects its provider per scope from the delivered `substrat:auth`; its SPA renders a
  redirect sign-in and invite-accept in OIDC mode. jose is bumped to v6 so node JWKS
  fetching goes through `fetch`, matching workerd.

  **Install-time identity** (dashboard): the New-app form's Identity section — builtin,
  a team Auth Server (the app is auto-registered there via RFC 7591 dynamic client
  registration against its real bound hostname), or an external issuer. Wiring failures
  mark the app failed with the reason on its audit trail.

- ec89a88: Vertical lifecycle: delete a vertical, and block new installs of one.

  **`deleteVertical`** (HostAdmin + `DELETE /verticals/:slug`, staff-only): removes the
  registry row, its versions, and its channels — **refused while any scope is still
  bound** to the vertical, naming the count, so a delete can never strand a live scope's
  version pin or routing. Deployed dispatch scripts are left as orphans for the cleanup
  script (#248), never reaped inline. Audited. The console's vertical detail card gets a
  type-the-slug-to-confirm Delete.

  **`installsBlocked`** (new registry flag + `setVerticalInstallsBlocked` /
  `POST /verticals/:slug/install-block`, staff-only): the install kill-switch, orthogonal
  to `listed`. A blocked vertical is hidden from the dashboard's install catalog and the
  control plane refuses to provision an instance of it (403) — for everyone, owner
  included. Existing scopes keep serving: it gates provisioning, not serving. Additive
  `installs_blocked` column in both adapters (attempt-and-tolerate migration, default 0).
  Console gets a Block/Allow installs toggle and a "blocked" badge.

  The console also now shows **timestamps**: when each version was pushed (table +
  promote picker), when each channel pointer last moved, and when a vertical was
  registered.

### Patch Changes

- 7ed3015: The dashboard Data tab works for Auth Server apps ("Couldn't load the database — internal error").

  **auth-server** now implements the §5.4 introspection verbs (`GET /internal/tables`,
  `GET /internal/tables/:table`): the issuer DO's Better Auth SQLite is a real per-scope
  database, and it answers the same two table-shaped, platform-gated reads a ScopeDO does.
  Secret-bearing columns are redacted inside the DO before anything crosses its boundary —
  password hashes, session tokens, OAuth tokens/client secrets, JWKS private keys, and the
  issuer's own signing secret (`config.value`, which also carries delivered `cfg:` entries
  such as ADMIN_PASSWORD) all come back `[redacted]`; ids, emails, timestamps and row
  counts stay readable.

  **control-plane-api**'s error boundary now passes a `ControlPlaneError` through verbatim
  (status + message) instead of collapsing it into the generic 500 "internal error". A
  vertical's honest refusal — e.g. a 501 for a verb it does not implement — reaches the
  dashboard as itself; routes that already hand-caught it are unchanged.

- Updated dependencies [cd32011]
- Updated dependencies [ec89a88]
  - @substrat-run/contracts@0.15.0
  - @substrat-run/kernel@0.15.0

## 0.14.1

### Patch Changes

- cb6131c: docs: point every published package's `homepage` at its substrat.net page and
  swap the stale `substrat.ahlstrand.es` doc links in READMEs for `substrat.net`.
  Add the three missing READMEs (`engine-booking`, `cli`, `control-plane-api`).
  Metadata/docs only — no code or API change; a republish is needed for the
  updated README + homepage to render on npm.
- Updated dependencies [cb6131c]
  - @substrat-run/contracts@0.14.1
  - @substrat-run/kernel@0.14.1

## 0.14.0

### Minor Changes

- 6a7768a: Add a declarative environment surface to the module manifest, carried on the registry.

  - **`envVarSpec` / `EnvVarSpec`** and an optional **`envSpec`** block on `moduleManifest`: a
    vertical declares the environment it needs — key, label, description, placeholder,
    `required`, `secret`, `default`, `group` — self-describing so a host or console can render a
    config form and validate required keys before deploy. Additive-only (decision 28).
  - **`resolveEnvSpec(spec, raw)`** resolves a declared spec against a raw environment (a Worker
    `env`, `process.env`, …): it reads only the declared keys (so the manifest is the single
    source of what an app consumes), applies each `default`, and reports absent `required` keys
    without throwing.
  - **The registry carries a vertical's `envSpec`.** A new `env_spec` column is added
    additively to the vertical registry in both the SQLite and Cloudflare adapters;
    `registerVertical` stores the spec and an otherwise-identical re-registration refreshes it.
    This lets a host/console render a config form for any registered vertical — a bundled
    builtin or a pushed builder vertical — without loading its code.
  - **The push flow carries it.** The `deployManifest` accepts an optional `envSpec`, and the
    `/verticals/:slug/deploy` handler passes it through `registerVertical` — so a pushed
    vertical's declared config reaches the registry (and the dashboard form) like a builtin's.

- a1c7649: **A read-only "Data" tab: browse an app's own database from the dashboard.**

  Cashes in the seam kernel-design §5.4 reserved as the _admin-query RPC_ — a grant "is a
  tuple in the scope's own database and needs an admin-query RPC" — as two narrow,
  read-only `HostAdmin` primitives, `listScopeTables` and `readScopeTable`, and surfaces
  them as a **Data** tab on the app detail view (list tables, page through rows).

  Read-only and table-shaped **by construction**: the caller picks a table from the live
  schema plus a bounded page — there is no user-supplied SQL, so there is no write path to
  forge the spine and no injection surface. The `_substrat_*` spine reads back too, flagged
  `system` so the UI groups it apart from the vertical's own tables. Every read is audited
  (K-24) and fails closed on a mismatched `(tenantId, scopeId)` pair (K-3).

  **Reaches the data where it actually lives.** One dashboard app = one scope = one
  Durable Object = one database. In embedded mode the dashboard's own host owns that DO, so
  it reads directly. In connected/prod the scope's data DO lives in the _vertical's own WfP
  deployment_ (K-31), not the control plane's own (empty-module) scope host — so the
  control-plane `/tables` route **delegates to the vertical** through `VerticalClient`
  (`GET /internal/tables`), the mirror of `provisionInstance`. `getScopeRecord` does the
  K-3 check + audit and names the backing vertical; the same `verticals[slug] ??
resolveVertical` resolution provisioning uses reaches it; a co-located host falls back to
  reading its own scope DB. The dashboard never emits an empty `200` — a null from the
  platform surfaces as a clear `502` instead of an "Unexpected end of JSON input".

  Additive throughout: new optional `HostAdmin` methods implemented by both adapters (with
  a shared contract-tests suite), new `contracts` introspection schemas, and
  `/internal/tables[/:table]` on the vertical workers (Meridian, Callout). Editing rows and
  an arbitrary read-only SQL console are deliberately out of scope (fast-follows).

### Patch Changes

- f4ad677: **Data view: read a scope's BOUND version, not the prod channel.** The connected-mode
  `/tenants/:t/scopes/:s/tables` introspection route delegated to the vertical resolved by
  the vertical's `prod` channel. But each `substrat push` is a separate Workers-for-
  Platforms script with its own Durable Object namespace, so a scope's data DO lives in the
  deployment of the version it was **bound** to (`scope.verticalVersionId`) — the same one
  the router serves it from. Once an installed app lagged prod, introspection resolved to
  the prod deployment and read an empty DO.

  Adds an optional `resolveVerticalVersion(slug, versionId, actor)` to `ControlPlaneApiOptions`;
  the route now prefers it (keyed by the scope's bound version), falling back to the
  prod-channel `resolveVertical` for a scope with no bound version, then to the host's own
  scope DB. Behaviour is unchanged for a freshly-installed app (bound == prod). Closes #220.

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0
  - @substrat-run/kernel@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies [74c9d7b]
  - @substrat-run/kernel@0.13.0
  - @substrat-run/contracts@0.13.0

## 0.12.0

### Minor Changes

- 05291fa: **Builder authz on the control-plane API (builder-plane.md Phase 2).** A second principal
  kind — a _tenant user_ — joins staff/service on the same surface, confined to the
  vertical-management routes and to the verticals their tenant **owns** (the `owner_tenant`
  column from Phase 1b). The mechanism ships tested against a stub; the real builder-session
  reader (session → user → selected tenant) and CLI wiring land with Phase 3.

  - **`authenticateBuilder?: BuilderAuth`** — a new, optional `createControlPlaneApi` option
    resolving a request to a `{ actor, tenantId }` builder principal. Tried only after
    `authenticate` (staff/service) declines, so staff auth is **unchanged** and remains a
    superset. Absent ⇒ the surface is staff/service-only exactly as before.
  - **Fail-closed confinement** — a builder reaches only an explicit allowlist of
    vertical-management routes (`GET`/`POST /verticals`, `…/versions`, `…/channels`, promote,
    deploy). Everything else — tenants, scopes, hostnames, admin-log, instance provisioning,
    and `versions/:id/{admit,reject}` — is `403` for a builder. Default-deny by design: a
    route not on the allowlist denies builders (a missing feature), never escalates.
  - **Ownership checks** — register/deploy **claim** an unregistered slug for the caller's
    tenant or require they already own it (`403` otherwise); publish/promote require ownership;
    `GET` of an unowned vertical is `404` (indistinguishable from absent, K-3's reflex). The
    owner is stamped from the principal, never trusted from the body. Staff pushes preserve the
    existing owner rather than clobbering it.
  - **Model B, staff keep the prod gate** — a builder self-serves `dev`/`staging` promotion;
    **`prod` promotion and admission stay staff-only**, the trust boundary self-serve-deploy.md
    §3 draws.
  - **`GET /verticals`** is filtered to the caller's owned verticals for a builder; staff see
    the whole registry.

  Internally the auth middleware now sets both `actor` (the audited subject, unchanged for
  every HostAdmin call) and a new `principal` (the authz distinction) — existing routes are
  untouched. `errors.ts` maps the Phase-1b claim conflict (`is owned by …`) to 409.

  Verified: control-plane-api suite (71) incl. a new builder-authz matrix — claim, cross-tenant
  refusal, list filtering, non-prod self-serve, staff-only prod/admit, deploy-path claim — and
  the control-plane worker suite (13) both pass; `pnpm -r typecheck` clean.

- 1dff2bd: **Builder writes — self-serve deploy, end to end (builder-plane.md Phase 3).** A tenant user
  can now `substrat login`, `push`, and `promote` their own verticals without staff, and the
  control plane forms the `<tenantSlug>/<name>` id they never type. This makes the Phase-2
  authz mechanism live.

  - **Prefixed vertical ids (`verticalSlug`)** — a new contracts brand allows an optional single
    `<tenantSlug>/` prefix; the registry schemas use it. A builder pushes a **bare** `--slug`;
    the control plane prepends their authenticated tenant's slug, so two tenants can each own a
    `helpdesk` with **no global claim race** (Vercel-style non-scarce namespace). Platform
    verticals stay bare. `deploymentRefFor` already flattens the `/`; hostnames never carry it.
  - **The live builder reader** (`oidcBuilderReader`, control-plane worker) — the same signed
    session the CLI/console carries resolves via the shared identity directory to the tenants a
    user belongs to, narrowed to the selected one → a `(actor, tenantId, tenantSlug)` builder
    principal. **No vetting roster**: self-serve is the point; a user with no workspace is
    declined (sign up in the dashboard first). The audited actor is a stable
    `PlatformActorId` derived from the OIDC subject.
  - **`effectiveSlug`** threads the prefix through every builder vertical route
    (`control-plane-api`), so ownership, filtering and dispatch all key on the real id.
  - **`GET /api/auth/whoami`** — the session's user + the tenants it can build for. The CLI
    calls it on `login` to store a default workspace (prompting when there are several).
  - **CLI** — `substrat whoami`; `substrat promote <slug> --channel dev|staging --version <id>`
    (a builder self-serves non-prod; prod + admission stay staff, model B); `--tenant` /
    `SUBSTRAT_TENANT` / a stored default, sent as `x-substrat-tenant` with a browser session.

  Scope: no auto-bootstrap of a workspace from the CLI (a builder signs up once in the
  dashboard, then the CLI just works) — flagged as a follow-up.

  Verified: control-plane-api (71) incl. the reworked builder matrix under prefixing (each
  tenant gets its own namespace, no collision), control-plane worker (17) incl. a live
  end-to-end builder path (bare push → `acme-co/helpdesk`, whoami, fail-closed no-workspace),
  adapter suites (147 + 153) and `pnpm -r typecheck` all pass.

- 7070588: **Push forwards `compatibility_flags`, and the deploy endpoint surfaces upload failures.**

  A pushed vertical that needs a compat flag — `nodejs_compat` for Better Auth / any `node:*` import — was being uploaded **without** it: the CLI manifest, the deploy schema, and the WfP metadata all carried only `compatibility_date`. So the script couldn't start, Cloudflare rejected the upload, and `deployVertical` threw — which the generic handler flattened into an anonymous `500 {"error":"internal error"}`, undiagnosable without worker logs. Callout hit exactly this.

  - **`compatibility_flags` now travels end to end**: `substrat push` reads it from `wrangler.jsonc` into the manifest (`deployManifest`/`VerticalBundle` gain `compatibilityFlags`), and `createWfpUploader` emits it in the script metadata.
  - **The deploy endpoint wraps `deployVertical`** and returns **`502 { error, detail }`** with the runtime's actual message (the builder is authenticated — this is platform/runtime error detail, not a bad request), plus a `console.error`, instead of a blank 500.

  Verified: control-plane-api suites pass, including new tests that `nodejs_compat` survives to the uploader and that an upload failure surfaces as a 502 with detail.

- 66e752b: **Add the deploy seam: `POST /verticals/:slug/deploy` (self-serve-deploy.md foundation).**

  A `substrat push` uploads a _built_ worker bundle to this endpoint, which validates the
  **sandbox contract**, forwards the bundle to an injected uploader (the host holds the
  Cloudflare credential — the builder never does, D-34), and records a **pending** version.
  A push is not a deploy; admission still gates serving.

  - New `deployVertical?: DeployVerticalFn` option — injected so the package holds no
    Cloudflare SDK and is unit-testable with a fake. Absent ⇒ the route 501s.
  - `assertSandboxContract` (self-serve-deploy.md §4): refuses an upload whose declared
    bindings would reach platform infrastructure — a `CONTROL_PLANE` binding, a cross-script
    DO binding, or a service binding to a platform worker → `403`. Structural refusal, not
    code inspection, is the primary defence against untrusted bundles.
  - `deploymentRef` is `<slug>-<versionId>` (a lowercased ULID) — a valid Cloudflare Worker
    script name, unlike the `@version` label the RFC sketched (`@`/`.` are illegal in script
    names). The human label stays on the version record.
  - Exports `assertSandboxContract`, `deployManifest`, `deploymentRefFor`, and the
    `DeployVerticalFn` / `VerticalBundle` types for hosts to implement the real uploader.
  - `createWfpUploader({ accountId, namespace, apiToken })` — a `DeployVerticalFn` that
    uploads the bundle into a Workers-for-Platforms dispatch namespace (pure `fetch` +
    `FormData`, so it runs in a Worker or node). Wired into `apps/control-plane` (behind the
    `CF_API_TOKEN`/`CF_ACCOUNT_ID` env) and the dev server. The `tools/substrat-push.mjs` CLI
    builds a vertical and pushes it to `/verticals/:slug/deploy`.
  - New `resolveVertical?: (slug, actor) => Promise<VerticalClient | undefined>` option — the
    provisioning dispatch swap (orchestration.md §5.4), tried after the static `verticals` map.
    `apps/control-plane` resolves a pushed vertical's `prod` version → `env.DISPATCH.get(ref)`,
    so `POST /verticals/:slug/instances` reaches a pushed vertical with no redeploy.

- cedaf1a: **Deploy path forwards a vertical's own D1 bindings (self-serve-deploy.md §4).**

  A `substrat push` now carries a vertical's `d1_databases` through to the Workers-for-Platforms upload, so a pushed vertical actually has its own data stores — not just its `ScopeDO`. This is what a CP-less vertical like Callout needs for its Better-Auth `AUTH_DB` to exist on the deployed worker.

  - **`DeclaredBinding` / `deployManifest`** gain an optional `id` — a `d1` binding's `database_id`, which previously would have been stripped at manifest parse.
  - **`tools/substrat-push.mjs`** maps `wrangler.jsonc`'s `d1_databases` to `{ type: 'd1', name: <binding>, id: <database_id> }` bindings alongside the DO bindings; `createWfpUploader` already forwards the binding set verbatim into the script metadata, which is the shape Cloudflare expects for a D1 binding.
  - **`assertSandboxContract`** still refuses only the platform's infrastructure (`CONTROL_PLANE`, service bindings, cross-script / foreign DO classes); a vertical's own `d1` store falls through and is allowed, matching §4 ("no `AUTH_DB` it did not create" — its own is fine). Documented open question: this check doesn't yet prove the vertical _owns_ the declared `database_id` rather than pointing at another tenant's DB — under model B that gap is closed by human admission, and by per-vertical store provisioning when self-serve opens wider.

  Not covered here (a separate mechanism, tracked next): **static assets.** A pushed vertical's SPA is not a binding — Cloudflare uploads it via a blake3-hashed assets-upload-session, which needs a server-side implementation in the uploader. Callout still needs that before it serves its UI from the dispatch namespace.

  Verified: control-plane-api suites pass, including a new deploy test that a `d1` binding (with its `database_id`) is accepted by the sandbox contract and forwarded to the uploader.

- 0de890b: **The platform injects `PLATFORM_SECRET` + `ROUTER_SECRET` into every pushed vertical.**

  A pushed vertical needs the platform's shared secrets to _verify_ inbound calls — `PLATFORM_SECRET` to accept the control plane's `/internal/provision` (K-31), `ROUTER_SECRET` to trust the router-asserted node (K-27). But `wrangler secret put` can't target a WfP dispatch-namespace script, so there was no clean way to set them per-vertical. And they aren't the builder's secrets — they're the platform's.

  - **`createWfpUploader` gains `injectSecrets`** — a name→value map added as `secret_text` bindings on every uploaded script. Injected server-side, _after_ the §4 sandbox check on the vertical's declared bindings (the platform is granting verification secrets, not the vertical reaching for a platform binding). Empty values are skipped.
  - **The control plane passes `env.PLATFORM_SECRET` + `env.ROUTER_SECRET`** into the uploader, so a pushed vertical is provisionable + servable with zero per-vertical secret setup.

  Set both on the control plane, redeploy, and re-push a vertical — it comes up holding the secrets it needs. Verified: control-plane-api suites pass, including new tests that the secrets land as `secret_text` bindings beside the vertical's own, and that an unset one is skipped.

- d5a7d5e: **Expose the vertical + version registry over the control-plane HTTP API (orchestration.md Phase 1a).**

  The registry data model — verticals, versions, channels, admission, and the digest-diff
  promotion gate — was already built at the `HostAdmin` + adapter layer but had no HTTP
  surface. This adds thin pass-through routes so a staff caller (and the console) can drive it:

  - `GET/POST /verticals` — list, register
  - `GET/POST /verticals/:slug/versions` — list, publish (lands **pending**; body slug must
    match the path, K-3-style cross-check)
  - `POST /verticals/:slug/versions/:id/{admit,reject}` — the admission checkpoint
  - `GET /verticals/:slug/channels` + `POST /verticals/:slug/channels/:channel/promote` — the
    promotion checkpoint, which refuses a changed permission/migration digest unless
    acknowledged
  - `POST /tenants/:tenantId/scopes/:scopeId/version` — bind a scope to an admitted version

  `errors.ts` gains status mappings so registry refusals surface as `404`/`409` rather than
  `500`. No `deploy` route (the worker uploader) — that is Phase 2. The actor is still stamped
  from the authenticated request, never the body.

### Patch Changes

- 097a3aa: **`deploymentRefFor` is prefix-safe** — builder plane Phase 1 groundwork.

  A builder-owned vertical's slug will be `<tenant>/<name>` (builder-plane.md). The
  dispatch script name must stay Cloudflare-safe (`[a-z0-9_-]`), so `deploymentRefFor`
  now flattens the `/` (and any other stray char) to `-`. A bare platform slug is
  unaffected (`callout-<id>`), so it's fully backward-compatible.

- 0572a3b: **Typecheck on the native (Go) TypeScript compiler — `typescript` 5.6 → 7.**

  TypeScript 7 (the native compiler, formerly the `tsgo`/`@typescript/native-preview`
  rewrite) is now GA as `typescript@latest`. The binary is still `tsc`, so every package's
  `tsc -p … --noEmit` script is unchanged — only the toolchain pin moves. No source or
  public API changes; this bumps the published packages solely because their build now runs
  through the native compiler.

  Full-workspace `pnpm -r typecheck` drops to ~3s wall; per-package the native checker is
  roughly an order of magnitude faster (kernel 1.33s → 0.07s, control-plane-api 1.50s →
  0.12s, engine-invoicing 0.91s → 0.06s on this machine).

  Two migration deltas TS7's stricter resolution surfaced (both green on 5.6, red on 7):

  - **CSS side-effect imports (`TS2882`).** `import './ui.css'` in the six Vite app/admin
    surfaces now needs an ambient declaration. Fixed the way `demos/meridian/app` already
    did it — `"types": ["vite/client"]` in each app `tsconfig.json` (vite/client declares
    `*.css`) — rather than adding a stray `vite-env.d.ts`.
  - **`boundary-lint` node globals (`TS2584`/`TS2591`).** The linter CLI's `process`,
    `console`, and `node:fs`/`node:path` imports stopped resolving because the base tsconfig
    leaves `types` unset and TS7 no longer implicitly pulls in `@types/node` here. Added an
    explicit `"types": ["node"]` to `packages/boundary-lint/tsconfig.json`.

  Note: TS7 is a major bump that drops deprecated 5.x behavior. Editors should run their
  TS Server on 7 to keep CLI and IDE diagnostics aligned.

- Updated dependencies [73c0cdb]
- Updated dependencies [1dff2bd]
- Updated dependencies [66e752b]
- Updated dependencies [0572a3b]
  - @substrat-run/contracts@0.12.0
  - @substrat-run/kernel@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
  - @substrat-run/kernel@0.11.0
  - @substrat-run/contracts@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
- Updated dependencies [3fb38da]
- Updated dependencies [2becfd5]
- Updated dependencies [d881f75]
  - @substrat-run/contracts@0.10.0
  - @substrat-run/kernel@0.10.0

## 0.9.0

### Minor Changes

- 27872cc: Scopes are provisioned as `provisioning` and activated on confirmation (K-31).

  `provisionScope` wrote the directory row as `active`, so the row claimed a usable
  scope before anything had built one — and only the vertical can build one, because the
  DO class bundles the modules and lives in the vertical's deployment. The `provisioning`
  state existed in the enum for exactly this and was unused.

  `HostAdmin.activateScope` moves `provisioning → active`, through the same transition
  graph the other lifecycle moves use, so it is audited and cannot revive a suspended
  scope. `getScope` refuses anything not active, so an unconfirmed row is inert rather
  than misleading.

  `ControlPlaneClient.activateScope` is the push-mode equivalent, and the control-plane
  API gains `POST /tenants/:t/scopes/:s/activate`.

  Migrations are still attempted for a `provisioning` scope before it is refused, so the
  lazy retry and its attempt counter survive — they are the only self-healing there is
  until the reconciliation sweep exists. A scope held back by a failed migration now
  reports the migration error rather than a bare "not active".

### Patch Changes

- Updated dependencies [27872cc]
  - @substrat-run/kernel@0.9.0
  - @substrat-run/contracts@0.9.0

## 0.8.0

### Minor Changes

- c9fe555: `VerticalClient` and `POST /verticals/:slug/instances` — the platform's side of K-31.

  Provisioning is control-plane-driven because only the vertical can create a usable
  scope DO: the DO class bundles the modules and lives in the vertical's own deployment.
  This is the mirror of `ControlPlaneClient`, pointing the other way — that one is a
  vertical talking up to the platform, this is the platform telling a vertical to act.

  Deliberately tiny. Provisioning is the only thing the platform asks a vertical to do,
  and every additional verb would be authority the platform holds over someone else's
  code.

  `createControlPlaneApi` takes an optional `verticals` map. A slug with no binding gets
  a **501** rather than a silent success: a control plane that does nothing while
  reporting success is worse than one that says it cannot. The vertical's own status is
  propagated rather than flattened to 500, because a 403 means the platform secrets do
  not match — a deployment error someone must act on.

### Patch Changes

- @substrat-run/contracts@0.8.0
- @substrat-run/kernel@0.8.0

## 0.7.0

### Minor Changes

- 017bb83: The hostname map is on the audited HTTP surface: `GET /hostnames`,
  `POST /hostnames`, `PATCH /hostnames/:hostname/status`.

  `resolveHostname` is deliberately **not** here. It is the router's per-request machine
  path, unaudited by design (K-24), and the router reads the directory directly. Putting
  it on the staff surface would either flood the admin log or quietly add an unaudited
  route to a surface whose whole claim is that it is audited.

  `ControlPlaneClient` is unchanged: that is the _vertical's_ client, and a vertical
  assigning itself a domain is not a thing we want to be possible.

### Patch Changes

- Updated dependencies [c54637b]
- Updated dependencies [8c48c93]
- Updated dependencies [33fb5dd]
  - @substrat-run/contracts@0.7.0
  - @substrat-run/kernel@0.7.0

## 0.6.0

### Minor Changes

- ea3c5de: Service auth for connected verticals, and a workerd fetch fix.

  - `serviceTokenAuth` + `SERVICE_TOKEN_HEADER` — a shared-token credential a
    vertical presents to register into the control plane (a service, not staff),
    and `firstPlatformActorAuth` to compose it with session/dev auth.
  - `ControlPlaneClient` gains a `serviceToken` option (sent as `x-service-token`).
  - **Fix:** `ControlPlaneClient` bound `globalThis.fetch` incorrectly, throwing
    "Illegal invocation" on workerd. It is now bound to the global scope, so the
    client works inside a Worker (over a service binding or plain fetch).

### Patch Changes

- @substrat-run/contracts@0.6.0
- @substrat-run/kernel@0.6.0

## 0.5.0

### Minor Changes

- 54c6583: Add the vertical-side connect seam and swappable staff auth.

  - `ControlPlaneClient` — a typed HTTP client that registers a tenant, entitlements,
    and scope into a separately-run control plane, plus `assertScopeActive`, a gate
    that fails closed on the directory's authoritative lifecycle (tenant-level
    cascade included). `fetch` is injectable.
  - `sessionPlatformAuth(readSession, resolveActor)` + `staffAllowlist` — the real
    `PlatformActorAuth` for platform staff, split so the auth provider and the staff
    roster are independent. Swapping the provider (e.g. to AuthHero) changes only the
    session reader.

### Patch Changes

- @substrat-run/contracts@0.5.0
- @substrat-run/kernel@0.5.0

## 0.4.0

### Minor Changes

- 6900431: The directory becomes readable, and gets an HTTP surface.

  **New package: `@substrat-run/control-plane-api`** (AGPL-3.0-only + commercial,
  like the kernel it sits on). One Hono router over `HostAdmin` — the audited
  control-plane transport. Web-standard only, so the same router mounts in a Worker
  holding the `controlPlane` binding or behind a Node server. It is not module code:
  it never receives a `ctx` and never runs in a scope's serialization domain.

  **`HostAdmin` gains a read side.** The write side was complete; nothing could
  enumerate what it had written.

  - `listScopes(filter?)` / `getScopeRecord(tenantId, scopeId)` — the scope
    inventory §3.2 always claimed the directory was. `getScopeRecord` cross-checks
    the pair and returns `undefined` for another tenant's scope, the same
    fail-closed rule `getScope` applies (K-3).
  - `listRoles(filter?)` — roles were writable and not enumerable since the
    permission model shipped. Returns `TenantRole` (a `RoleDefinition` plus its
    tenant).
  - `auditLog(filter?)` widens: filter by scope, actor, action or time; `limit`,
    `cursor` and `order`. The cursor is the entry's own ULID — order is
    chronological, so a page carries its own continuation. **The default order is
    unchanged** (oldest first), so existing callers do not shift.

  **The `scope` contract is now enforced rather than aspirational.** It described
  `slug`/`kind`/`name`/`parentScopeId` and was parsed by nothing while the table had
  none of those columns. Every read now parses through it, and `Scope` gains
  `vertical`.

  **`ProvisionScopeInput` extends additively** — `slug`, `kind`, `name`, `vertical`
  are optional with behaviour-preserving defaults, so existing callers are
  untouched. An unnamed scope's slug defaults to its lowercased id (a ULID
  lowercases into a valid slug, so it is valid and unique by construction).

  **`schemaVersion` and `vertical` stop being placeholders.** Both shipped as
  columns written by nothing — `schemaVersion` was always `'0'`, `vertical` always
  `null`. `schemaVersion` is now the applied-migration count; `vertical` is stamped
  onto audit targets for scope-lifecycle actions.

  **Directory schema change, applied in place by both adapters.** The `scopes` table
  gains `parent_scope_id`/`slug`/`kind`/`name`/`vertical`, plus a unique index on
  `(tenant_id, slug)` and one on `tenants(slug)`. The directory is not a module and
  has no `SqlMigration[]` journal, so each adapter upgrades on open: add the columns,
  backfill legacy rows to the same defaults `resolveScopeRecord` applies, then create
  the unique indexes **after** the backfill (a unique index over NULL slugs would
  permit the duplicates it exists to forbid). No action is required of callers; an
  existing directory opens and migrates itself.

  **Slug uniqueness is now enforced**, which it never was despite the contract saying
  "unique within tenant". `createTenant` and `provisionScope` fail closed on a
  collision rather than reporting a silent no-op — `INSERT OR IGNORE` would have
  swallowed a colliding-slug-different-id create and reported it as idempotent.

### Patch Changes

- Updated dependencies [6900431]
  - @substrat-run/contracts@0.4.0
  - @substrat-run/kernel@0.4.0
