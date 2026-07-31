# @substrat-run/demo-manyfold

## 0.3.0

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

- 77760b8: Multi-scope Manyfold, D1: an admin can request a new site (the intent producer).

  Manyfold gains a `content:manage-sites` permission (held by `admin`) and a `manyfold/request-site`
  operation: a tenant admin asks for a new site, and — since the vertical is sandbox-clean and can't
  provision a scope itself — the op enqueues a `provision-sibling` platform intent
  (platform-intents.md) via `ctx.requestPlatform`, seating the requesting admin as the new site's
  owner, and returns the request id. The platform's drain (Phases B2/C) picks it up and provisions
  the sibling.

  **Permission checkpoint:** a new key `content:manage-sites` appears in `demos/manyfold/PERMISSIONS.md`,
  granted only to `admin` — the reviewable diff for this widening.

  Scenario-tested: an admin's request enqueues a durable `provision-sibling` intent (owner = the
  admin); an author (lacking `content:manage-sites`) is denied.

  Not yet wired: the vertical's `/internal/platform-requests` endpoints (so the platform drain can
  reach these intents — needs `tenantId` threaded through the merged `VerticalClient`), the
  `POST /api/sites` route + "New site" UI, and the router kick. Those are the next D slice. Refs #358.

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

### Patch Changes

- Updated dependencies [fbf0704]
- Updated dependencies [41d01f6]
- Updated dependencies [50d9260]
- Updated dependencies [0e9eba7]
  - @substrat-run/contracts@0.31.0
  - @substrat-run/vertical-auth@0.5.0
  - @substrat-run/kernel@0.31.0
  - @substrat-run/adapter-sqlite@0.31.0
  - @substrat-run/adapter-cloudflare@0.31.0

## 0.2.0

### Minor Changes

- ad4ccbf: Manyfold multi-scope, M2: a per-tenant site registry so the app lists and switches its sites.

  The per-tenant `IdentityDO` gains a site registry (`recordSite` / `listSites` /
  `resolveSiteScope`, logic factored into `site-registry.ts` so it is unit-testable without a
  Durable Object). Manyfold's worker records each site at `/internal/provision`, serves the
  tenant's sites at `GET /api/sites` (previously 404 in production, which left the switcher
  empty), and resolves the app's `x-site` slug selection to the corresponding scope in `nodeFor`
  — so the existing in-app site switcher now actually switches sites on a deployed install.
  `nodeFor` is split from a sync `baseNode` (the routed tenant + home scope, which the auth
  provider keys on) so the async site resolution never touches the auth path. Tenant isolation is
  unchanged: the registry is per-tenant and `getScope` re-checks the (tenant, scope) pair.

### Patch Changes

- Updated dependencies [ad4ccbf]
- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
- Updated dependencies [91a60e2]
  - @substrat-run/vertical-auth@0.4.0
  - @substrat-run/contracts@0.30.0
  - @substrat-run/kernel@0.30.0
  - @substrat-run/adapter-sqlite@0.30.0
  - @substrat-run/adapter-cloudflare@0.30.0

## 0.1.15

### Patch Changes

- Updated dependencies [c64bdf8]
  - @substrat-run/adapter-cloudflare@0.29.0
  - @substrat-run/vertical-auth@0.3.3
  - @substrat-run/contracts@0.29.0
  - @substrat-run/kernel@0.29.0
  - @substrat-run/adapter-sqlite@0.29.0

## 0.1.14

### Patch Changes

- Updated dependencies [d696b78]
  - @substrat-run/adapter-cloudflare@0.28.0
  - @substrat-run/vertical-auth@0.3.2
  - @substrat-run/contracts@0.28.0
  - @substrat-run/kernel@0.28.0
  - @substrat-run/adapter-sqlite@0.28.0

## 0.1.13

### Patch Changes

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0
  - @substrat-run/kernel@0.27.0
  - @substrat-run/adapter-sqlite@0.27.0
  - @substrat-run/adapter-cloudflare@0.27.0

## 0.1.12

### Patch Changes

- Updated dependencies [2bdd22b]
  - @substrat-run/contracts@0.26.0
  - @substrat-run/kernel@0.26.0
  - @substrat-run/adapter-cloudflare@0.26.0
  - @substrat-run/adapter-sqlite@0.26.0
  - @substrat-run/vertical-auth@0.3.1

## 0.1.11

### Patch Changes

- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/contracts@0.25.0
  - @substrat-run/kernel@0.25.0
  - @substrat-run/adapter-sqlite@0.25.0
  - @substrat-run/adapter-cloudflare@0.25.0

## 0.1.10

### Patch Changes

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

- f610140: Each demo vertical's declarative surface now lives in its own crisp files instead of being
  embedded at the top of `module.ts`. Open `src/manifest.ts` and you see the _entire_ shape of
  the vertical — permission keys, id/version, events, entity relations, entitlement — with
  nothing executable to wade through; `src/module.ts` is now just operations and the
  `ModuleRegistration` wiring.

  For each of Callout, Meridian, and Manyfold:

  - **`src/manifest.ts`** — the permission-key consts (`SC_PERM`/`HR_PERM`/`MF_PERM`) **and**
    `moduleManifest.parse({...})`. The consts sit beside the manifest's `permissions` list —
    they're the same keys twice — so "add a permission" stays a single-file edit and the pair
    can't drift.
  - **`src/migrations.ts`** — the append-only `SqlMigration[]` journal (Callout's
    `boundary-lint-allow R5` extraction block moved with the migration it guards).
  - **`src/module.ts`** — imports both; holds row types, operations, and the module wiring.

  Each package gains a `./manifest` export subpath so the dashboard catalog reads a vertical's
  permission consts without dragging `seed.ts`'s `node:fs`/SQLite into the Worker bundle
  (`manifest.ts` imports only from `@substrat-run/contracts`). The `new-vertical` skill now
  scaffolds this three-file shape. Pure reorganization — no behavior, schema, or permission
  change (permission snapshots unchanged; all demo + dashboard scenario tests green).

- Updated dependencies [72b1128]
- Updated dependencies [1cfce31]
- Updated dependencies [aa503c2]
- Updated dependencies [5a3ef82]
- Updated dependencies [4c275df]
- Updated dependencies [d4bf108]
- Updated dependencies [d4bf108]
  - @substrat-run/contracts@0.24.0
  - @substrat-run/kernel@0.24.0
  - @substrat-run/adapter-sqlite@0.24.0
  - @substrat-run/adapter-cloudflare@0.24.0
  - @substrat-run/vertical-auth@0.3.0

## 0.1.9

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0
  - @substrat-run/adapter-cloudflare@0.23.0
  - @substrat-run/adapter-sqlite@0.23.0
  - @substrat-run/kernel@0.23.0

## 0.1.8

### Patch Changes

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
- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0
  - @substrat-run/adapter-cloudflare@0.22.0
  - @substrat-run/adapter-sqlite@0.22.0

## 0.1.7

### Patch Changes

- Updated dependencies [3354e26]
  - @substrat-run/adapter-cloudflare@0.21.0
  - @substrat-run/contracts@0.21.0
  - @substrat-run/kernel@0.21.0
  - @substrat-run/adapter-sqlite@0.21.0

## 0.1.6

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0
  - @substrat-run/adapter-sqlite@0.20.0
  - @substrat-run/adapter-cloudflare@0.20.0

## 0.1.5

### Patch Changes

- Updated dependencies [b4a6bee]
- Updated dependencies [83aa7fd]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/adapter-cloudflare@0.19.0
  - @substrat-run/kernel@0.19.0
  - @substrat-run/adapter-sqlite@0.19.0

## 0.1.4

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0
  - @substrat-run/adapter-sqlite@0.18.0
  - @substrat-run/adapter-cloudflare@0.18.0

## 0.1.3

### Patch Changes

- @substrat-run/contracts@0.17.0
- @substrat-run/kernel@0.17.0
- @substrat-run/adapter-sqlite@0.17.0
- @substrat-run/adapter-cloudflare@0.17.0

## 0.1.2

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [b2ab362]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0
  - @substrat-run/adapter-sqlite@0.16.0
  - @substrat-run/adapter-cloudflare@0.16.0
  - @substrat-run/vertical-auth@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [cd32011]
- Updated dependencies [d93e690]
- Updated dependencies [ec89a88]
  - @substrat-run/adapter-cloudflare@0.15.0
  - @substrat-run/adapter-sqlite@0.15.0
  - @substrat-run/contracts@0.15.0
  - @substrat-run/vertical-auth@0.2.0
  - @substrat-run/kernel@0.15.0

## 0.1.0

### Minor Changes

- 21ebd1e: **Manyfold — a multi-scope headless CMS demo vertical.** A sandbox-clean, deployable vertical
  where **site = scope**: one install, many sites. The vertical owns the editorial lifecycle
  (draft→in_review→approved→published state machine that can't skip, append-only revisions,
  freeze-on-publish with a content hash, a delivery surface that resolves references — a
  draft/archived target comes back explicitly unresolved). **Content types are data**, authored
  in a model builder (`save-type`/`list-types`), each compiling to a reviewable migration
  (never a live ALTER); bodies persist as JSON so adding a field is free.

  Ships the full app: content editor + workflow, the model builder (models, field editor,
  relationship map, migration preview), and Members & roles — all URL-routed so a refresh
  restores the view. Auth is the tenant's own `IdentityDO` (Better Auth): first sign-in claims
  the owner seat (→ admin), then **member invites** (mint a principal, grant a role at scope
  level, share an accept link) open the post-setup join path. The deployable worker is
  sandbox-clean (own `ScopeDO` + `IdentityDO`, SPA inlined, no privileged bindings).

  Also fixes permission-denial status on the Cloudflare DO adapter: an op's error crosses the
  `ScopeDO` RPC boundary and is rebuilt as a plain `Error`, so `instanceof PermissionDenied`
  was false and denials degraded to 400 — now matched by message too, so denials are 403 on
  the worker as in node.

  Registers Manyfold in the dashboard catalog (`connected`) and bundles its module in the
  dashboard worker.

### Patch Changes

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0
  - @substrat-run/adapter-sqlite@0.14.0
  - @substrat-run/adapter-cloudflare@0.14.0
  - @substrat-run/kernel@0.14.0
