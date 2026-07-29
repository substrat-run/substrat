# @substrat-run/cli

## 0.9.3

### Patch Changes

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

  - @substrat-run/contracts@0.28.0

## 0.9.2

### Patch Changes

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

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0

## 0.9.1

### Patch Changes

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

- Updated dependencies [2bdd22b]
  - @substrat-run/contracts@0.26.0

## 0.9.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/contracts@0.25.0

## 0.8.0

### Minor Changes

- 5a3ef82: Ship the vertical's declared permission surface in the deploy manifest (D-39).

  The permission registry — every key + description a registered manifest declares, the
  role templates provisioning defines, and the entity-grant shapes — existed only at build
  time as `demos/*/PERMISSIONS.md`. The deploy manifest carried `ownerGrants` and a
  `digests.permission` HASH of that surface, so the platform committed (at promotion) to
  content it did not hold, and the dashboard kept a hardcoded third copy. Worse, the digest
  was a placeholder: it hashed the worker's `bindings`, not any permission content, so the
  "permissions changed" promotion checkpoint fired on binding changes and missed real
  permission changes.

  Now `deployManifest` carries a first-class `registry` (`permissionRegistry`:
  `permissions[]` with `declaredBy`, `roles[]`, `entityGrants[]`), and `digests.permission`
  is its content hash. `tools/permission-diff.mts` emits a machine-readable
  `permissions.json` next to `PERMISSIONS.md` — from the SAME `MODULES` + `ROLES` +
  `ENTITY_GRANTS` the host registers — CI-checked with `--check`, so it cannot drift from
  what is enforced and it never requires the CLI to load (or execute) module code. `push`
  reads that checked-in artifact and injects it; the digest is a canonical, formatting-
  independent hash of the surface, so it moves iff a key, description, role, or grant shape
  moves. Additive and optional (D-28): a vertical shipping no registry hashes the empty
  surface (never bindings again), and the control-plane trust-boundary parse accepts the
  new field unchanged.

  This is what a tenant-facing permissions view (and a real version-to-version admission
  diff) consume without new backend plumbing.

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

- Updated dependencies [72b1128]
- Updated dependencies [1cfce31]
- Updated dependencies [aa503c2]
- Updated dependencies [5a3ef82]
- Updated dependencies [4c275df]
- Updated dependencies [d4bf108]
  - @substrat-run/contracts@0.24.0

## 0.7.0

### Minor Changes

- 6a86837: Builders keep the substrate vocabulary (#190 part B, D-38): a vertical declares what it
  needs from the runtime in Substrat terms — `substrat.runtimeNeeds` in package.json
  (`entry`, `needsNodeCompat`, an optional pre-bundle `build` command, and its own
  `stores`: binding → durable state class) — and never authors `wrangler.jsonc`. At push
  time the CLI derives the wrangler config (`wranglerConfigFor`), feeds it to the bundler
  via `--config` (written next to the vertical, removed after the build), and assembles
  the deploy manifest from the same derived object, so declaration and bundle cannot
  drift. The compatibility date is the platform's `RUNTIME_BASELINE` (new in contracts) —
  a builder states needs, never substrate config.

  The vocabulary is complete at four fields _because_ the §4 sandbox contract is strict:
  it refuses everything except a vertical's own stores, so own-stores + node-compat + a
  build command is the whole of what a builder may legitimately say. Datastores beyond
  own stores are deliberately absent — those are platform-provisioned, never
  bundle-declared. A hand-authored `wrangler.jsonc` remains the expert/legacy path and is
  ignored (with a note) when `runtimeNeeds` is present.

  Honest limit, unchanged from the issue: this neutralizes the _declaration_, not the
  _toolchain_ — wrangler still bundles in the builder's CI.

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0

## 0.6.2

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0

## 0.6.1

### Patch Changes

- @substrat-run/contracts@0.21.0

## 0.6.0

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

## 0.5.3

### Patch Changes

- Updated dependencies [b4a6bee]
  - @substrat-run/contracts@0.19.0

## 0.5.2

### Patch Changes

- d18a247: `HostAdmin.setTenantName` + `PATCH /tenants/:tenantId` — a display-only rename (the
  slug, which registry ids key on, never moves). The dashboard's identity mirror uses
  it to keep the shared directory's tenant names in step with team names, so the CLI's
  workspace picker shows the organization, not a placeholder; the CLI now lists
  workspaces name-first.
- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0

## 0.5.1

### Patch Changes

- @substrat-run/contracts@0.17.0

## 0.5.0

### Minor Changes

- 0caa0a9: Account switching actually works: force past the IdP SSO cookie and the browser session.

  Before this, "sign in as a different account" was impossible: `/api/auth/logout` only
  cleared the app's own `sb_session` cookie, the IdP's SSO cookie survived, and the next
  authorize round-trip silently re-authenticated the old user — no typed email could win.
  The CLI broker added a second layer: `substrat login` reused any live browser session
  without ever showing a login screen.

  **oidc-rp**: `/api/auth/login` now passes through an allowlisted `prompt`
  (`login` | `select_account`) so the IdP re-prompts past its SSO session, and
  `/api/auth/logout?federated` chains through the issuer's `end_session_endpoint`
  (RP-initiated logout, discovery-driven; local-only remains the default so other apps
  on the shared IdP session keep theirs).

  **control-plane**: the CLI login broker accepts `fresh=1` — it skips the live browser
  session and bounces through `/api/auth/login?prompt=login`, stripping `fresh` from the
  returnTo so the post-login bounce uses the new session instead of looping.

  **cli**: `substrat login --fresh` requests exactly that flow, and
  `substrat workspaces` lists your workspaces (an alias of `whoami`).

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

## 0.4.0

### Minor Changes

- f9db289: `substrat push` resolves its workspace from the project, never the machine: `--tenant` →
  `SUBSTRAT_TENANT` → a `"substrat": { "tenant" }` pin in the vertical's `package.json`. The
  machine-wide login default is deliberately out of the chain — the first push of a slug
  **claims** `<workspace>/<slug>` for whatever workspace resolved (builder-plane.md §5), so a
  stale global default silently pointing at the wrong workspace would claim the vertical for
  the wrong owner.

  A first interactive push with no pin lists your workspaces (whoami), auto-selects a sole
  one, and offers to write the pin into `package.json` — repo-scoped, reviewable, shared with
  every teammate and CI — so the question is answered once per project, not once per push. A
  non-TTY push with no pin refuses with an actionable error instead of guessing. The push
  line now prints the full target (`pushing acme-co/crm@0.1.0 …`) so the claiming workspace
  is always visible; service-token pushes are unchanged (the platform actor has no
  workspace). `promote`/`scope pull` keep the login-default fallback — ownership is already
  checked server-side there.

  `resolveAuth` gains `useDefaultTenant: false` and a `kind: 'session' | 'service'` field;
  `readVerticalMeta` reads the new `substrat.tenant`; new `pinTenant(dir, tenant)` writes it
  back preserving the file's indentation. Docs: CLI reference gets the full command surface
  (`whoami`, `versions`, `publish`/`unpublish`, flagless `push` defaults table, first-push
  transcript) and the deploying guide explains the per-project pin.

## 0.3.1

### Patch Changes

- cb6131c: docs: point every published package's `homepage` at its substrat.net page and
  swap the stale `substrat.ahlstrand.es` doc links in READMEs for `substrat.net`.
  Add the three missing READMEs (`engine-booking`, `cli`, `control-plane-api`).
  Metadata/docs only — no code or API change; a republish is needed for the
  updated README + homepage to render on npm.

## 0.3.0

### Minor Changes

- 1cbc2be: `substrat push` carries a vertical's declared env-spec to the registry. The CLI reads
  `substrat.envSpec` from the vertical's `package.json` — the same static, code-free source it
  already reads `slug`/`name` from — and includes it in the deploy manifest, so a pushed vertical
  gets a Dashboard config form exactly like a builtin.
- 1022c15: **Registry-driven marketplace, phase 3b** (marketplace-publish.md §5) — request-to-publish in
  place, so a builder can drive the whole loop.

  - `HostAdmin.requestPublish(actor, slug)` — an owner records a pending publish request; sets the
    registry `publish_requested_at` on the vertical (both adapters), audited (`requestPublish` admin
    action). `setVerticalListed` now **clears** the request when staff reviews and lists it, so the
    pending queue drains itself.
  - Control-plane endpoint `POST /verticals/:slug/publish-request` — **owner-checked** and on the
    builder allowlist, so an owner asks with a bare slug; staff listing stays the gate.
  - CLI `substrat publish <slug>` now _requests_ listing ("✓ publish requested … an operator will
    review it") instead of flipping it; `substrat unpublish` is the staff unlist.

  The full loop — builder requests → `publishRequestedAt` set → staff lists → `listed` true + request
  cleared — is covered end-to-end (contract-suite across both adapters + a control-plane API test).
  The dashboard "Request to publish" button + a console pending-requests list are the remaining UX.

- 1022c15: **Registry-driven marketplace, phase 1** (marketplace-publish.md) — carry a vertical's
  install metadata to the registry on push, so a later phase can drop the dashboard's hardcoded
  `CATALOG` map.

  - `moduleManifest` gains additive fields: `ownerGrants: permissionKey[]` (the day-one owner
    grant — the role _table_ stays vertical-owned + runtime-customizable), `entitlements`, and
    `provides` / `requires` **capability** lists (`oidc-issuer` etc., wired tenant-side through
    the connection store — no `kind` flag, no bundling). New `capability` contract type.
  - The registry `vertical` + `registerVerticalInput` carry all four; stored as one
    `install_spec` JSON column in both adapters (sqlite + cloudflare), via the existing
    `ensureColumn`/`addColumn` helper, alongside `env_spec`.
  - `substrat push` reads them from `package.json` `substrat.*` and the control-plane deploy
    endpoint validates + stores them on `registerVertical` — exactly the rail `envSpec` rides.

  No behaviour change yet: the dashboard still gates on `CATALOG`. Phase 2 makes
  `availableCatalog`/`createApp` registry-driven.

- 1022c15: **Registry-driven marketplace, phase 3** (marketplace-publish.md §5) — the publish action.

  - `HostAdmin.setVerticalListed(actor, slug, listed)` — a staff admission that flips the registry
    `listed` flag (both adapters); idempotent, audited (`setVerticalListed` admin action). Once
    `listed`, `availableCatalog` offers the vertical to every tenant.
  - Control-plane endpoint `POST /verticals/:slug/listing` — **staff-only** (not on the builder
    allowlist), so a builder is refused (the review gate), staff flips it. Mirrors admission (model B).
  - CLI `substrat publish <slug>` / `substrat unpublish <slug>`.

  The `listed` column is set on insert and by this action only — **never clobbered by a re-push**
  (covered by a contract-suite test across both adapters). Any owner may _request_ publishing;
  staff review is the gate (§5). The builder self-serve request surface (a dashboard "Request to
  publish" button) is the remaining UX — the same open question as builder-plane's prod-promotion
  request.

## 0.2.0

### Minor Changes

- 32abe73: **`substrat push` needs no flags.** Run it from inside the vertical and it defaults everything:

  - **dir** → `.` (the current directory).
  - **`--slug` / `--name`** → from a `"substrat": { "slug", "name" }` block in the vertical's
    `package.json`, or derived from the package name (`@substrat-run/demo-meridian` → `meridian`
    / `Meridian`).
  - **`--version`** → the registry's latest for that slug, **patch-bumped** — no more hand-tracking
    the number (falls back to the package.json version for a slug's first-ever push).

  So `cd demos/meridian && substrat push` replaces
  `substrat push demos/meridian --slug meridian --version 0.0.13 --name Meridian`. Every flag still
  works as an override. Adds `substrat` blocks to the Meridian + Callout demo package.json.

## 0.1.0

### Minor Changes

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

- cc5f2ca: **`substrat login` — a real browser login for the CLI (loopback OAuth, no AuthHero change).**

  `substrat login` now pops the browser and authenticates you as yourself — the `wrangler login` / `gh auth login` experience — instead of pasting a shared token. The CLI never touches AuthHero: it logs in **through the control plane**, which already brokers AuthHero for the console, and gets back the same signed session it issues to a browser.

  - **The flow (PKCE, CLI ↔ control plane):** the CLI starts a localhost server, opens `…/api/auth/cli?port&state&challenge`; the broker signs the user in (bouncing through the existing `/api/auth/login` if there's no session yet, via a new same-origin `returnTo`) and redirects to `127.0.0.1:PORT/callback?code`; the CLI exchanges `code + verifier` for the session token. The token never transits a URL — only the PKCE-bound `code` does — and the exchange fails without the matching verifier.
  - **`@substrat-run/oidc-rp`**: exports `mintSession` (refactored out of `completeLogin`), `signEphemeral`/`verifyEphemeral`, `pkceS256`, and `safePath`; `mountOidcRoutes` honours a validated same-origin `returnTo`.
  - **`apps/control-plane`**: `oidcStaffBearerReader` accepts the session as `Authorization: Bearer` (the same `verifySession`, the **same staff roster** gate as the cookie); `cli-auth.ts` mounts the broker routes. Pushes are attributed to the **human**, not a shared actor. **No AuthHero client or redirect URI is added** — AuthHero still only ever redirects to the console.
  - **`@substrat-run/cli`**: the loopback `login` flow (default); `login --token` / `SUBSTRAT_SERVICE_TOKEN` still stores a service credential for CI. `push` sends whichever the config resolves — a bearer session (per-human) or `x-service-token` (service actor).

  Verified: oidc-rp, control-plane, dashboard and cli typecheck; a new workerd test drives the whole broker end-to-end — the PKCE round-trip issues a bearer the deploy surface accepts, a wrong verifier is refused (400), and a valid session for a non-rostered user is refused (401, fail closed).

- 9d3c4a3: **`@substrat-run/cli` is now public — published to npm under Apache-2.0.** The deploy CLI holds
  no platform IP (it builds your vertical locally and POSTs a bundle; the control plane holds the
  Cloudflare credential), so it ships permissively — the industry norm for a deploy CLI — while
  the rest of the platform stays AGPL + commercial.

  - `private: true` removed; `publishConfig.access: public`, `repository`, `homepage`, `keywords`,
    and `engines` (`node >= 20`) added; license changed from AGPL-3.0-or-later to **Apache-2.0**
    (with a per-package `LICENSE`, shipped in the tarball).
  - Install: `npm install -g @substrat-run/cli`.

  Docs: the [Deploying a vertical](https://substrat.net/guide/deploying) guide is rewritten for
  the builder plane (the `<workspace>/<slug>` prefix, `whoami`, `--tenant`, `promote`, the
  dashboard Deployments view), a new `@substrat-run/cli` reference page is added, and the
  dashboard platform page documents the Deployments tab.

- ed99919: **`substrat versions <slug>`** — list a vertical's versions and which channels point at
  them, from the CLI. The first slice of _builder self-service visibility_: seeing the
  verticals you pushed without the staff console.

  It reads the existing registry endpoints (`/verticals/:slug/versions`, `/channels`), so
  it works for staff today and — once builder-scoped authz + slug ownership land — for
  builders viewing their own verticals. Read-only; admission and prod promotion stay the
  staff trust gate (self-serve-deploy.md model B).

- 7070588: **Push forwards `compatibility_flags`, and the deploy endpoint surfaces upload failures.**

  A pushed vertical that needs a compat flag — `nodejs_compat` for Better Auth / any `node:*` import — was being uploaded **without** it: the CLI manifest, the deploy schema, and the WfP metadata all carried only `compatibility_date`. So the script couldn't start, Cloudflare rejected the upload, and `deployVertical` threw — which the generic handler flattened into an anonymous `500 {"error":"internal error"}`, undiagnosable without worker logs. Callout hit exactly this.

  - **`compatibility_flags` now travels end to end**: `substrat push` reads it from `wrangler.jsonc` into the manifest (`deployManifest`/`VerticalBundle` gain `compatibilityFlags`), and `createWfpUploader` emits it in the script metadata.
  - **The deploy endpoint wraps `deployVertical`** and returns **`502 { error, detail }`** with the runtime's actual message (the builder is authenticated — this is platform/runtime error detail, not a bad request), plus a `console.error`, instead of a blank 500.

  Verified: control-plane-api suites pass, including new tests that `nodejs_compat` survives to the uploader and that an upload failure surfaces as a 502 with detail.

- fbd2627: **A real `substrat` CLI — authenticated vertical deploys (replaces `tools/substrat-push.mjs`).**

  The push capability is now a proper package (`@substrat-run/cli`, `bin: substrat`) with a stored credential, instead of a bare script that only worked against a dev control plane.

  - **`substrat login`** stores the control-plane URL + `SERVICE_TOKEN` in `~/.substrat/config.json` (chmod 600, token prompt hidden). **`substrat push <dir> --slug --version`** builds the vertical (`wrangler --dry-run`, running its own `build.command`), assembles the manifest (DO + D1 bindings), and uploads. Auth resolves flag → env (`SUBSTRAT_CP_URL` / `SUBSTRAT_SERVICE_TOKEN`) → config.
  - **Authenticates as the platform service actor via `x-service-token`** (`serviceTokenAuth`), not the dev-only `x-platform-actor` header the old script sent. That header is trusted only under `ALLOW_DEV_ACTOR=true`, so the old script could not push to a production control plane at all; this can. No `--actor` is chosen — the service token _is_ the identity. No control-plane change: `serviceTokenAuth` was already wired.
  - Removed `tools/substrat-push.mjs`; `pnpm substrat …` (root script) and `demos/callout/wrangler.example.jsonc` point at the CLI. Push stays PENDING — admission in the console still gates serving.

  Run: `pnpm -r build` then `pnpm substrat login` → `pnpm substrat push demos/callout --slug callout --version 0.1.0`.
