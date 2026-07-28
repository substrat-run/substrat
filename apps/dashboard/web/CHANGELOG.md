# @substrat-run/dashboard-web

## 0.2.0

### Minor Changes

- 22b1f97: Export & import from the dashboard (preview-and-snapshots.md §8's dashboard half):
  the Snapshots tab grows an Export & import card. Export downloads the app's data as
  a `.dump.json` the CLI's `scope restore` also accepts — in connected mode it arrives
  PII-masked from the control plane's governed export route (the full-fidelity
  break-glass stays a CLI/staff affordance); embedded mode returns the full read
  (`masked: false`), since the host's files already sit on the operator's own disk.
  Import replaces the app's data wholesale with an uploaded dump (a pulled export or a
  locally built world), always forking a TTL'd safety copy first so the pre-restore
  state survives as a snapshot to back out to. Both halves gate on
  `dashboard:provision-app` in the caller's own scope and land on the app's activity
  trail as `data-exported` / `data-restored` (migration 0008 widens the event CHECK,
  rebuild-and-copy like 0005/0007). New tenant-narrowed CP wrappers `exportScope` /
  `restoreScope` reach the existing staff routes over the service binding.

### Patch Changes

- 6a22014: The app Deployments tab no longer dead-ends a builder on their own vertical. The
  per-app deployments read now says whether the app's vertical is one the tenant
  pushed (`owned`, with the real `listed` flag alongside), and the tab words itself
  accordingly: for an owned private vertical the banner says promotion is self-serve
  and links to the Verticals page instead of claiming prod is a staff action (true
  only for listed/foreign verticals). When the newest admitted version isn't what
  prod points at — the exact state where no "Update to latest" can be offered — the
  Running card now explains why and links to the promote button (or names the staff
  handoff, for the non-owned case) rather than showing nothing.
- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0

## 0.1.10

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0

## 0.1.9

### Patch Changes

- @substrat-run/contracts@0.21.0

## 0.1.8

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0

## 0.1.7

### Patch Changes

- Updated dependencies [b4a6bee]
  - @substrat-run/contracts@0.19.0

## 0.1.6

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0

## 0.1.5

### Patch Changes

- @substrat-run/contracts@0.17.0

## 0.1.4

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0

## 0.1.3

### Patch Changes

- Updated dependencies [cd32011]
- Updated dependencies [297e057]
- Updated dependencies [ec89a88]
  - @substrat-run/contracts@0.15.0
  - @substrat-run/ui@0.1.1

## 0.1.2

### Patch Changes

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

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0

## 0.1.1

### Patch Changes

- Updated dependencies [74c9d7b]
  - @substrat-run/contracts@0.13.0

## 0.1.0

### Minor Changes

- f2428a9: **The Dashboard UI — the tenant-facing surface, built from the design review (docs/design/dashboard-ui.md).**

  "Vercel, for Substrat" as a real React app, on the same design system as the operator console.

  - **Shared `@substrat-run/ui`** — the design-system primitives (Button, Input, Table, SideNav,
    Dialog, tokens, `styles.css`, icons) EXTRACTED from `apps/console` into a source-only workspace
    package (no build step; the Vite apps transpile it). The console now re-exports it through a thin
    `components` barrel + `@import "@substrat-run/ui/styles.css"` — its `../components` import paths
    are unchanged, so this is an internal refactor with no behaviour change.
  - **`@substrat-run/dashboard-web`** — a new Vite + React SPA (`apps/dashboard/web`), hash-routed,
    every screen from the handoff: sign-in, onboarding, Apps grid/list, Create App (Git import /
    marketplace / CLI), App Detail (Overview + Deployments / Env Vars / Domains / Integrations /
    Settings tabs), Team + roles matrix, Domains, Integrations, Billing, Analytics, Settings, plus
    the ⌘K palette, notifications, an account menu, dark mode, and the shell. **M0 is wired** to the
    real worker API (`/api/me`, `/api/catalog`, `/api/apps`); M1–M3 + future screens run on demo data
    behind the design's honesty banners. A `VITE_DEV_MOCK` preview mode (mirroring the console's
    `VITE_DEV_ACTOR` seam) renders the demo tenant without OIDC; `?theme=`/`?menu=` aid screenshots.
  - **`@substrat-run/dashboard` worker** now **serves the SPA** as Workers static assets
    (`run_worker_first: ["/api/*"]` + `single-page-application` fallback) instead of the old inline
    page (deleted); `/api/me` also surfaces the signed-in email/name for the shell.
  - **The catalog offers a real Callout**, not just Documents. The worker bundles the Callout
    vertical's modules via a new worker-safe `@substrat-run/demo-callout/module` subpath (just
    `calloutModule` + `SC_PERM`, never the seed/auth) plus `workorder` + `invoicing`. `createApp`
    grants the three-engine SKU + the office-admin owner grants and **binds a default hostname**
    `<slug>.<jurisdiction>.substrat.run` (K-30 → `callout.global.substrat.run`), best-effort, recorded
    on the app row. M0 stand-in: production deploys Callout separately (dashboard.md §6 — router + DNS
    - ACM + control-plane `provisionInstance`), and per master-plan D-33 a demo is COPIED as a
      template, not imported.

  Verified: 4/4 dashboard scenario tests (incl. a new one provisioning a real Callout scope at
  `callout.global.substrat.run` and driving a live engine op), console + web typecheck, boundary-lint,
  builds, `wrangler --dry-run`, and a live local worker serving the SPA + returning Callout in the
  catalog.

  **Remaining (beyond this PR):** the router reading the directory, `*.substrat.run` DNS + ACM cert,
  and provisioning each app as a separate deployment via the control plane — until then a bound
  hostname is recorded but does not yet resolve.

### Patch Changes

- b09b120: **Create-app URL preview shows `.global.substrat.run`, matching the real binding.**

  The Configure step previewed `<slug>.substrat.run`, but provisioning binds
  `<slug>.global.substrat.run` (K-30: `<slug>.<jurisdiction>.substrat.run`, jurisdiction
  defaults to `global`). Fixed the suffix so the preview matches what actually gets bound.

- 10b9805: **Delete app tolerates a double-click.** A fast second click re-sent `DELETE` for an
  already-deleted app → `list-apps` no longer had it → 404 "app not found" (an error
  toast, though the first delete succeeded). The handler now guards against a concurrent
  in-flight delete (an `in-flight` ref) and treats a 404 as the desired end state (already
  gone) rather than an error.
- Updated dependencies [73c0cdb]
- Updated dependencies [1dff2bd]
- Updated dependencies [f2428a9]
- Updated dependencies [3d73be3]
- Updated dependencies [66e752b]
- Updated dependencies [0572a3b]
  - @substrat-run/contracts@0.12.0
  - @substrat-run/ui@0.1.0
